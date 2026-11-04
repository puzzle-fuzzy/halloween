import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  TrashEntry,
  TrashListing as TrashList,
  TrashPurgeResult,
  TrashRestoreResult as TrashRestore,
} from '@halloween/contracts'
import { atomicJson, HTTPError, syncDirectory } from './storage'

export type {
  TrashEntry,
  TrashListing as TrashList,
  TrashPurgeResult,
  TrashRestoreResult as TrashRestore,
} from '@halloween/contracts'
export type TrashIO = Pick<typeof fs, 'rename' | 'cp' | 'rm' | 'link' | 'mkdir' | 'rmdir'>
interface TrashHost {
  dataRoot: string
  stateRoot: string
  normalize(value: unknown): string
  resolve(value: unknown, allowMissing?: boolean): Promise<string>
}
interface Manifest {
  version?: number
  originalPath: string
  deletedAt: number
  state?: 'copying' | 'ready' | 'purging'
}
interface InventoryEntry {
  path: string
  type: 'file' | 'dir'
  size: number
  hash?: string
  mtime: number
  ctime: number
}
interface Inventory {
  entries: InventoryEntry[]
  size: number
  errors: string[]
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code
}
async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file)
    return true
  } catch (error) {
    if (code(error) === 'ENOENT') return false
    throw error
  }
}
function itemId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value === '.' ||
    value === '..' ||
    /[/\\\0]/.test(value) ||
    Buffer.byteLength(value) > 255
  )
    throw new HTTPError(400, 'invalid trash id')
  return value
}
async function digest(file: string): Promise<string> {
  const hash = createHash('sha256')
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    for await (const chunk of createReadStream(file, { fd: handle.fd, autoClose: false }))
      hash.update(chunk)
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

/** Never follows links. Damaged entries remain measurable where possible. */
async function inventory(root: string, hashes = false): Promise<Inventory> {
  const result: Inventory = { entries: [], size: 0, errors: [] }
  const visit = async (absolute: string, relative: string): Promise<void> => {
    let stat: Awaited<ReturnType<typeof fs.lstat>>
    try {
      stat = await fs.lstat(absolute)
    } catch {
      result.errors.push('cannot read recycled content')
      return
    }
    if (stat.isSymbolicLink()) {
      result.errors.push('symbolic links are not recoverable')
      return
    }
    if (stat.isFile()) {
      let hash: string | undefined
      if (hashes) {
        try {
          hash = await digest(absolute)
        } catch {
          result.errors.push('cannot verify recycled content')
          return
        }
      }
      result.entries.push({
        path: relative,
        type: 'file',
        size: stat.size,
        hash,
        mtime: stat.mtimeMs,
        ctime: stat.ctimeMs,
      })
      result.size += stat.size
    } else if (stat.isDirectory()) {
      result.entries.push({
        path: relative,
        type: 'dir',
        size: 0,
        mtime: stat.mtimeMs,
        ctime: stat.ctimeMs,
      })
      let names: string[]
      try {
        names = (await fs.readdir(absolute)).sort()
      } catch {
        result.errors.push('cannot read recycled directory')
        return
      }
      for (const name of names) {
        if (name.includes('\\') || name.includes('\0')) {
          result.errors.push('unsupported entry names are not recoverable')
          continue
        }
        await visit(path.join(absolute, name), relative ? `${relative}/${name}` : name)
      }
    } else result.errors.push('special files are not recoverable')
  }
  await visit(root, '')
  return result
}
function comparable(value: Inventory, sourceMetadata = false): string {
  return JSON.stringify(
    value.entries.map((entry) => ({
      path: entry.path,
      type: entry.type,
      size: entry.size,
      hash: entry.hash,
      ...(sourceMetadata ? { mtime: entry.mtime, ctime: entry.ctime } : {}),
    })),
  )
}

/** Called only inside CloudFiles' shared mutation/snapshot lock. */
export class TrashStore {
  private readonly io: TrashIO
  private readonly root: string
  constructor(
    private readonly host: TrashHost,
    overrides: Partial<TrashIO> = {},
  ) {
    this.io = {
      rename: fs.rename,
      cp: fs.cp,
      rm: fs.rm,
      link: fs.link,
      mkdir: fs.mkdir,
      rmdir: fs.rmdir,
      ...overrides,
    }
    this.root = path.join(host.stateRoot, 'trash')
  }
  private async rootExists(create = false): Promise<boolean> {
    if (!(await exists(this.root))) {
      if (!create) return false
      await this.io.mkdir(this.root, { mode: 0o700 })
      await syncDirectory(this.host.stateRoot)
    }
    const stat = await fs.lstat(this.root)
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new HTTPError(400, 'invalid trash directory')
    return true
  }
  private async manifest(directory: string): Promise<Manifest> {
    const file = path.join(directory, 'manifest.json'),
      stat = await fs.lstat(file)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64 * 1024)
      throw new Error('invalid trash manifest')
    const raw: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('invalid trash manifest')
    const value = raw as Partial<Manifest>
    const originalPath = this.host.normalize(value.originalPath)
    if (originalPath === '/' || !Number.isSafeInteger(value.deletedAt) || value.deletedAt! < 0)
      throw new Error('invalid trash manifest')
    if (value.version !== undefined && value.version !== 2)
      throw new Error('unsupported trash manifest')
    if (value.version === 2 && !['copying', 'ready', 'purging'].includes(value.state ?? ''))
      throw new Error('invalid trash manifest')
    return {
      originalPath,
      deletedAt: value.deletedAt!,
      ...(value.version ? { version: value.version, state: value.state } : {}),
    }
  }
  private async describe(id: string): Promise<{ entry: TrashEntry; incomplete: boolean }> {
    const directory = path.join(this.root, id)
    const entry: TrashEntry = {
      id,
      originalPath: null,
      deletedAt: null,
      type: 'unknown',
      size: 0,
      recoverable: false,
    }
    let incomplete = false
    const stat = await fs.lstat(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      if (stat.isFile()) entry.size = stat.size
      return {
        entry: { ...entry, error: 'invalid trash entry' },
        incomplete: stat.isSymbolicLink(),
      }
    }
    let manifest: Manifest | undefined
    try {
      manifest = await this.manifest(directory)
      entry.originalPath = manifest.originalPath
      entry.deletedAt = manifest.deletedAt
    } catch {
      entry.error = 'missing or damaged trash manifest'
    }
    const content = path.join(directory, 'content')
    if (await exists(content)) {
      const payload = await inventory(content)
      entry.size = payload.size
      entry.type = payload.entries[0]?.type ?? 'unknown'
      if (payload.errors.length) {
        entry.error = payload.errors[0]
        incomplete = true
      }
      if (manifest?.state === 'copying')
        entry.error = 'incomplete recycle operation; original data was retained'
      if (manifest?.state === 'purging')
        entry.error = 'permanent deletion did not finish; remaining content cannot be restored'
      entry.recoverable = Boolean(manifest && !entry.error)
    } else {
      entry.error ??=
        manifest?.state === 'copying'
          ? 'incomplete recycle operation; original data was retained'
          : 'recycled content is missing'
      // Count interrupted copy staging data too, without exposing it as recoverable.
      for (const name of await fs.readdir(directory))
        if (name.startsWith('.content-')) {
          const staging = await inventory(path.join(directory, name))
          entry.size += staging.size
        }
      incomplete = true
    }
    return { entry, incomplete }
  }
  async list(): Promise<TrashList> {
    if (!(await this.rootExists())) return { entries: [], totalBytes: 0, incomplete: false }
    const entries: TrashEntry[] = []
    let incomplete = false
    for (const id of await fs.readdir(this.root)) {
      try {
        const result = await this.describe(id)
        entries.push(result.entry)
        incomplete ||= result.incomplete
      } catch {
        entries.push({
          id,
          originalPath: null,
          deletedAt: null,
          type: 'unknown',
          size: 0,
          recoverable: false,
          error: 'cannot inspect trash entry',
        })
        incomplete = true
      }
    }
    entries.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0) || a.id.localeCompare(b.id))
    return { entries, totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0), incomplete }
  }
  private async copyVerified(source: string, staging: string): Promise<void> {
    const before = await inventory(source, true)
    if (before.errors.length) throw new HTTPError(400, before.errors[0]!)
    await this.io.cp(source, staging, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
      preserveTimestamps: true,
    })
    const copied = await inventory(staging, true),
      after = await inventory(source, true)
    if (
      copied.errors.length ||
      after.errors.length ||
      comparable(before) !== comparable(copied) ||
      comparable(before, true) !== comparable(after, true)
    )
      throw new HTTPError(409, 'copy verification failed; source data was retained')
    for (const entry of copied.entries)
      if (entry.type === 'file') {
        const handle = await fs.open(path.join(staging, entry.path), 'r+')
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
    for (const entry of [...copied.entries].reverse())
      if (entry.type === 'dir') await syncDirectory(path.join(staging, entry.path))
    await syncDirectory(path.dirname(staging))
  }
  async recycle(sources: { absolute: string; relative: string }[]): Promise<string[]> {
    // Validate every tree before any item is moved.
    for (const source of sources) {
      const scan = await inventory(source.absolute)
      if (scan.errors.length) throw new HTTPError(400, scan.errors[0]!)
    }
    await this.rootExists(true)
    const ids: string[] = []
    try {
      for (const source of sources) {
        const id = `${Date.now()}-${randomUUID()}`,
          directory = path.join(this.root, id)
        await this.io.mkdir(directory, { mode: 0o700 })
        // Make the recovery directory reachable after a power loss before any
        // source removal can become durable.
        await syncDirectory(this.root)
        const manifest: Manifest = {
          version: 2,
          originalPath: source.relative,
          deletedAt: Date.now(),
          state: 'ready',
        }
        const content = path.join(directory, 'content'),
          file = path.join(directory, 'manifest.json')
        await atomicJson(file, manifest)
        try {
          await this.io.rename(source.absolute, content)
        } catch (error) {
          if (code(error) !== 'EXDEV') throw error
          await atomicJson(file, { ...manifest, state: 'copying' })
          const staging = path.join(directory, `.content-${randomUUID()}.partial`)
          try {
            await this.copyVerified(source.absolute, staging)
            await this.io.rename(staging, content)
            // A crash/deletion failure from here leaves a complete recovery copy.
            await atomicJson(file, manifest)
            await this.io.rm(source.absolute, { recursive: true })
          } catch (copyError) {
            // Keep any published content, and preserve the source on copy failures.
            await this.io.rm(staging, { recursive: true, force: true }).catch(() => {})
            throw copyError
          }
        }
        await syncDirectory(directory)
        await syncDirectory(path.dirname(source.absolute))
        ids.push(id)
      }
    } catch (error) {
      if (ids.length) {
        const reason =
          error instanceof HTTPError
            ? error.message
            : ['EACCES', 'EPERM'].includes(code(error) ?? '')
              ? 'permission denied'
              : code(error) === 'ENOSPC'
                ? 'storage full'
                : 'operation failed'
        throw new HTTPError(
          500,
          `some items were moved to the recycle bin before a later item failed (${reason}); refresh files and the recycle bin`,
        )
      }
      throw error
    }
    return ids
  }
  private async publish(source: string, destination: string, type: 'file' | 'dir'): Promise<void> {
    if (type === 'file') {
      // Atomic no-replace publication, including an unexpected concurrent target.
      await this.io.link(source, destination)
      // Retain the original until the caller has recorded successful publication.
      return
    }
    // Reserve an empty destination atomically; rename may replace only our empty
    // reservation, and cannot merge into or erase a concurrently populated folder.
    await this.io.mkdir(destination, { mode: 0o700 })
    try {
      await this.io.rename(source, destination)
    } catch (error) {
      const retryable =
        process.platform === 'win32' && ['EPERM', 'EEXIST', 'ENOTEMPTY'].includes(code(error) ?? '')
      await this.io.rmdir(destination).catch(() => {})
      if (retryable) {
        await this.io.rename(source, destination)
        return
      }
      throw error
    }
  }
  async restore(value: unknown, destination?: unknown): Promise<TrashRestore> {
    const id = itemId(value)
    if (!(await this.rootExists()) || !(await exists(path.join(this.root, id))))
      throw new HTTPError(404, 'trash item not found')
    const { entry } = await this.describe(id)
    if (!entry.recoverable || !entry.originalPath || entry.type === 'unknown')
      throw new HTTPError(409, 'trash item is not recoverable')
    const relative = this.host.normalize(
      destination === undefined ? entry.originalPath : destination,
    )
    if (relative === '/') throw new HTTPError(400, 'cannot restore over cloud root')
    const parentRelative = path.posix.dirname(relative)
    let parent: string
    try {
      parent = await this.host.resolve(parentRelative)
    } catch (error) {
      if (error instanceof HTTPError && error.status === 404)
        throw new HTTPError(404, 'restore parent does not exist')
      throw error
    }
    if (!(await fs.lstat(parent)).isDirectory())
      throw new HTTPError(400, 'restore parent is not a directory')
    const target = await this.host.resolve(relative, true)
    if (await exists(target)) throw new HTTPError(409, 'target exists')
    const directory = path.join(this.root, id),
      source = path.join(directory, 'content')
    let published = false
    try {
      try {
        await this.publish(source, target, entry.type)
        published = true
      } catch (error) {
        if (code(error) === 'EEXIST' || code(error) === 'ENOTEMPTY')
          throw new HTTPError(409, 'target exists')
        if (code(error) !== 'EXDEV') throw error
        const staging = path.join(parent, `.halloween-restore-${randomUUID()}`)
        try {
          await this.copyVerified(source, staging)
          // Recheck parent components before publishing copied data.
          await this.host.resolve(parentRelative)
          await this.publish(staging, target, entry.type)
          published = true
        } finally {
          await this.io.rm(staging, { recursive: true, force: true }).catch(() => {})
        }
      }
      await syncDirectory(parent)
      await this.io.rm(directory, { recursive: true })
      await syncDirectory(this.root)
      return { ok: true, path: relative }
    } catch (error) {
      if (published)
        return {
          ok: true,
          path: relative,
          warning: 'restored successfully, but recycle-bin cleanup did not finish',
        }
      if (code(error) === 'EEXIST' || code(error) === 'ENOTEMPTY')
        throw new HTTPError(409, 'target exists')
      throw error
    }
  }
  async purge(options: unknown): Promise<TrashPurgeResult> {
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw new HTTPError(400, 'invalid purge request')
    const body = options as { ids?: unknown; all?: unknown; confirmation?: unknown }
    if (body.all !== undefined && typeof body.all !== 'boolean')
      throw new HTTPError(400, 'all must be a boolean')
    const all = body.all === true
    if (all && body.ids !== undefined) throw new HTTPError(400, 'choose ids or all, not both')
    if (body.confirmation !== (all ? 'EMPTY_TRASH' : 'DELETE'))
      throw new HTTPError(400, 'explicit permanent-delete confirmation required')
    let ids: string[]
    if (all) {
      ids = (await this.rootExists()) ? await fs.readdir(this.root) : []
    } else {
      if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 1000)
        throw new HTTPError(400, 'ids must contain 1 to 1000 trash items')
      ids = [...new Set(body.ids.map(itemId))]
      if (!(await this.rootExists())) throw new HTTPError(404, 'trash item not found')
      for (const id of ids)
        if (!(await exists(path.join(this.root, id))))
          throw new HTTPError(404, 'trash item not found')
    }
    let purged = 0
    const failed: { id: string; error: string }[] = []
    for (const id of ids) {
      const directory = path.join(this.root, id)
      let started = false
      try {
        const stat = await fs.lstat(directory)
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          // A partial recursive rm must never leave an apparently complete item.
          let manifest: Manifest | undefined
          try {
            manifest = await this.manifest(directory)
          } catch {
            /* Already damaged. */
          }
          await atomicJson(
            path.join(directory, 'manifest.json'),
            manifest
              ? { ...manifest, version: 2, state: 'purging' }
              : { version: 2, state: 'purging' },
          )
        }
        started = true
        // fs.rm unlinks symbolic links themselves without following their targets.
        await this.io.rm(directory, { recursive: true })
        purged++
      } catch {
        failed.push({
          id,
          error: started
            ? 'permanent deletion did not finish; remaining content cannot be restored'
            : 'could not start permanent deletion; the item was retained',
        })
      }
    }
    if (purged) await syncDirectory(this.root)
    return failed.length ? { ok: false, purged, failed } : { ok: true, purged }
  }
}
