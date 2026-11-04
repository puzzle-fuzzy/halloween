import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { HTTPError, serialExecutor } from './storage'
import { TrashStore } from './trash'
import type { TrashIO, TrashList, TrashRestore, TrashPurgeResult } from './trash'
import type { FileEntry } from '@halloween/contracts/files'
export type { TrashEntry, TrashList, TrashRestore, TrashPurgeResult } from './trash'
export type { FileEntry } from '@halloween/contracts/files'

export function relativePath(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\')) throw new HTTPError(400, 'invalid path')
  const parts = value.split('/').filter(Boolean)
  if (parts.some((part) => part === '..' || part.startsWith('.'))) throw new HTTPError(400, 'hidden or traversing paths are not allowed')
  return '/' + parts.join('/')
}

export class CloudFiles {
  private mutate = serialExecutor()
  private readonly recycleBin: TrashStore
  constructor(readonly dataRoot: string, readonly stateRoot: string, readonly maxUploadBytes = 100 * 1024 ** 3, trashIO?: Partial<TrashIO>) {
    this.recycleBin = new TrashStore({ dataRoot, stateRoot, normalize: relativePath, resolve: (value, allowMissing) => this.resolve(value, allowMissing) }, trashIO)
  }

  /** Non-reentrant: work may read/copy files, but must not call a locked method. */
  withSnapshot<T>(work: () => Promise<T>): Promise<T> { return this.mutate(work) }
  listTrash(): Promise<TrashList> { return this.mutate(() => this.recycleBin.list()) }
  restoreTrash(id: unknown, destination?: unknown): Promise<TrashRestore> { return this.mutate(() => this.recycleBin.restore(id, destination)) }
  purgeTrash(options: unknown): Promise<TrashPurgeResult> { return this.mutate(() => this.recycleBin.purge(options)) }

  async resolve(value: unknown, allowMissing = false): Promise<string> {
    const rel = relativePath(value)
    let current = this.dataRoot
    for (const part of rel.split('/').filter(Boolean)) {
      current = path.join(current, part)
      const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (allowMissing && error.code === 'ENOENT') return null
        if (error.code === 'ENOENT') throw new HTTPError(404, 'not found')
        throw error
      })
      if (stat?.isSymbolicLink()) throw new HTTPError(400, 'symbolic links are not allowed')
    }
    return current
  }

  async list(value: unknown): Promise<FileEntry[]> {
    const rel = relativePath(value)
    const abs = await this.resolve(rel)
    if (!(await fs.lstat(abs)).isDirectory()) throw new HTTPError(400, 'not a directory')
    const entries: FileEntry[] = []
    for (const d of await fs.readdir(abs, { withFileTypes: true })) {
      if (d.name.startsWith('.') || d.isSymbolicLink()) continue
      const stat = await fs.lstat(path.join(abs, d.name))
      if (!stat.isFile() && !stat.isDirectory()) continue
      entries.push({ name: d.name, type: stat.isDirectory() ? 'dir' : 'file', size: stat.isFile() ? stat.size : 0, mtime: stat.mtimeMs, path: path.posix.join(rel, d.name) })
    }
    return entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)
  }

  async upload(directory: unknown, filename: unknown, body: ReadableStream<Uint8Array> | null): Promise<{ ok: true; name: string; size: number }> {
    return this.mutate(async () => {
      if (typeof filename !== 'string' || !filename || filename.includes('/') || relativePath(filename) === '/') throw new HTTPError(400, 'invalid name')
      const dir = await this.resolve(directory)
      if (!(await fs.lstat(dir)).isDirectory()) throw new HTTPError(400, 'not a directory')
      if (!body) throw new HTTPError(400, 'empty body')
      const target = path.join(dir, filename)
      if (await fs.lstat(target).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false
        throw error
    })) throw new HTTPError(409, 'target exists')
      const tmp = path.join(dir, `.halloween-upload-${randomUUID()}`)
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined
      try {
        handle = await fs.open(tmp, 'wx', 0o600)
        let size = 0
        for await (const chunk of body) {
          size += chunk.length
          if (size > this.maxUploadBytes) throw new HTTPError(413, 'upload exceeds MAX_UPLOAD_BYTES')
          let offset = 0
          while (offset < chunk.length) {
            const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset)
            if (!bytesWritten) throw new Error('upload write made no progress')
            offset += bytesWritten
          }
        }
        await handle.sync()
        await handle.close()
        handle = undefined
        await this.resolve(directory)
        // link is an atomic no-replace operation. The mutation lock also prevents
        // a directory rename/delete from moving an in-progress temporary file.
        try { await fs.link(tmp, target) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new HTTPError(409, 'target exists'); throw error }
        return { ok: true, name: filename, size: (await fs.lstat(target)).size }
      } finally {
        await handle?.close()
        await fs.rm(tmp, { force: true })
      }
    })
  }

  mkdir(value: unknown) {
    return this.mutate(async () => {
      if (relativePath(value) === '/') throw new HTTPError(400, 'invalid path')
      await fs.mkdir(await this.resolve(value, true), { recursive: true, mode: 0o700 })
    })
  }

  rename(from: unknown, to: unknown) {
    return this.mutate(async () => {
      const fromRel = relativePath(from), toRel = relativePath(to)
      if (fromRel === '/' || toRel === '/' || toRel.startsWith(fromRel + '/')) throw new HTTPError(400, 'invalid path')
      const source = await this.resolve(fromRel)
      const target = await this.resolve(toRel, true)
      const exists = await fs.lstat(target).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return false; throw e })
      if (exists) throw new HTTPError(409, 'target exists')
      await fs.rename(source, target)
    })
  }

  trash(values: unknown): Promise<{ deleted: number; trashIds: string[] }> {
    return this.mutate(async () => {
      if (!Array.isArray(values) || values.some((v) => typeof v !== 'string')) throw new HTTPError(400, 'paths must be an array')
      const paths = [...new Set(values.map(relativePath))]
      if (paths.includes('/')) throw new HTTPError(400, 'cannot delete root')
      const roots = paths.filter((p) => !paths.some((other) => other !== p && p.startsWith(other + '/')))
      // Validate every source before moving anything.
      const sources = await Promise.all(roots.map((rel) => this.resolve(rel)))
      const trashIds = await this.recycleBin.recycle(roots.map((relative, index) => ({ relative, absolute: sources[index]! })))
      return { deleted: roots.length, trashIds }
    })
  }

  async search(query: string): Promise<FileEntry[]> {
    const q = query.trim().toLowerCase(), entries: FileEntry[] = []
    if (!q) return entries
    const walk = async (rel: string, depth: number): Promise<void> => {
      if (depth > 8 || entries.length >= 500) return
      for (const entry of await this.list(rel)) {
        if (entry.name.toLowerCase().includes(q)) entries.push(entry)
        if (entry.type === 'dir') await walk(entry.path, depth + 1)
        if (entries.length >= 500) break
      }
    }
    await walk('/', 0)
    return entries
  }
}
