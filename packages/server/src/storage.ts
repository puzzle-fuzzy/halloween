import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export class HTTPError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

/** fsync a directory so a preceding rename survives a crash.
 * Windows cannot fsync directories through Node's file API (like PostgreSQL
 * and SQLite, we skip it there — NTFS metadata journaling covers renames);
 * some POSIX filesystems (network fs) also report EINVAL/ENOTSUP. */
export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await fs.open(directory, 'r')
  try {
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EBADF') throw error
  } finally {
    await handle.close()
  }
}

export async function atomicJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(tmp, 'wx', 0o600)
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(tmp, file)
    await syncDirectory(path.dirname(file))
  } finally {
    await handle?.close()
    await fs.rm(tmp, { force: true })
  }
}

export async function readJson<T>(file: string, parse: (raw: unknown) => T, fallback: T): Promise<T> {
  let raw: string
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file')
    raw = await fs.readFile(file, 'utf8')
    await fs.chmod(file, 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw new Error(`Cannot read state ${file}`, { cause: error })
  }
  try { return parse(JSON.parse(raw)) }
  catch (error) { throw new Error(`Invalid state ${file}; restore a valid backup before starting`, { cause: error }) }
}

export async function initializeRoots(dataRoot: string, stateRoot: string): Promise<{ dataRoot: string; stateRoot: string }> {
  await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 })
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 })
  const data = await fs.realpath(dataRoot)
  const state = await fs.realpath(stateRoot)
  if (data === state || data.startsWith(state + path.sep) || state.startsWith(data + path.sep)) {
    throw new Error('DATA_ROOT and STATE_ROOT must be separate, non-overlapping directories')
  }
  await fs.chmod(state, 0o700)
  return { dataRoot: data, stateRoot: state }
}

/** Validate before migration, and never silently replace an existing state file. */
export async function migrateState<T>(dataRoot: string, stateRoot: string, legacyName: string, name: string, parse: (raw: unknown) => T, fallback: T): Promise<T> {
  const legacy = path.join(dataRoot, legacyName)
  const target = path.join(stateRoot, name)
  const oldExists = await fs.lstat(legacy).then(() => true, (e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return false
    throw e
  })
  const targetExists = await fs.lstat(target).then(() => true, (e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return false
    throw e
  })
  if (oldExists) {
    const old = await readJson(legacy, parse, fallback)
    if (targetExists) {
      const current = await readJson(target, parse, fallback)
      if (JSON.stringify(old) !== JSON.stringify(current)) {
        throw new Error(`Both ${legacy} and ${target} exist with different contents; reconcile them before starting`)
      }
    } else {
      await atomicJson(target, old)
    }
    await fs.unlink(legacy)
  }
  return readJson(target, parse, fallback)
}

/** Serialize mutations within this single server process. */
export function serialExecutor() {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work, work)
    tail = result.catch(() => {})
    return result
  }
}
