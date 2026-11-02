import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { CloudFiles } from '../src/files'
import type { TrashIO } from '../src/trash'
import { HTTPError } from '../src/storage'

const temporary: string[] = []
afterEach(async () => { for (const root of temporary.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
type Roots = { root: string; dataRoot: string; stateRoot: string }
async function fixture(overrides?: (roots: Roots) => Partial<TrashIO>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'halloween-trash-')); temporary.push(root)
  const dataRoot = path.join(root, 'data'), stateRoot = path.join(root, 'state')
  await fs.mkdir(dataRoot); await fs.mkdir(stateRoot)
  const roots = { root, dataRoot, stateRoot }, files = new CloudFiles(dataRoot, stateRoot, 1024 * 1024, overrides?.(roots))
  async function write(relative: string, content: string) {
    const file = path.join(dataRoot, relative)
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content)
  }
  async function legacy(id: string, manifest: unknown = { originalPath: '/legacy.txt', deletedAt: 10 }, content: string | null = 'legacy') {
    const item = path.join(stateRoot, 'trash', id); await fs.mkdir(item, { recursive: true })
    if (manifest !== null) await fs.writeFile(path.join(item, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
    if (content !== null) await fs.writeFile(path.join(item, 'content'), content)
    return item
  }
  return { ...roots, files, write, legacy }
}
function crossDevice() { return Object.assign(new Error('cross volume'), { code: 'EXDEV' }) }
function denied() { return Object.assign(new Error('permission denied'), { code: 'EACCES' }) }
async function status(work: Promise<unknown>, expected: number) {
  try { await work; throw new Error('operation unexpectedly succeeded') }
  catch (error) { expect(error).toBeInstanceOf(HTTPError); expect((error as HTTPError).status).toBe(expected) }
}
async function absent(file: string) { expect(await fs.lstat(file).then(() => false, () => true)).toBe(true) }

describe('recycle-bin metadata and recovery', () => {
  test('empty listing does not create a directory, and old manifests remain recoverable', async () => {
    const f = await fixture()
    expect(await f.files.listTrash()).toEqual({ entries: [], totalBytes: 0, incomplete: false })
    await absent(path.join(f.stateRoot, 'trash'))
    await f.legacy('old-item')
    const result = await f.files.listTrash()
    expect(result.entries[0]).toEqual({ id: 'old-item', originalPath: '/legacy.txt', deletedAt: 10, type: 'file', size: 6, recoverable: true })
    expect(result.totalBytes).toBe(6); expect(result.incomplete).toBe(false)
    expect(await f.files.restoreTrash('old-item')).toEqual({ ok: true, path: '/legacy.txt' })
    expect(await fs.readFile(path.join(f.dataRoot, 'legacy.txt'), 'utf8')).toBe('legacy')
    expect((await f.files.listTrash()).entries).toEqual([])
  })
  test('lists exact payload byte totals for files and nested directories', async () => {
    const f = await fixture(); await f.write('one.txt', 'abc'); await f.write('folder/a', '12'); await f.write('folder/deep/b', '3456')
    const { trashIds } = await f.files.trash(['/one.txt', '/folder'])
    const result = await f.files.listTrash()
    expect(result.entries).toHaveLength(2); expect(result.totalBytes).toBe(9); expect(result.incomplete).toBe(false)
    const folder = result.entries.find((item) => item.originalPath === '/folder')!
    expect(folder.type).toBe('dir'); expect(folder.size).toBe(6); expect(folder.recoverable).toBe(true)
    await f.files.restoreTrash(folder.id)
    expect(await fs.readFile(path.join(f.dataRoot, 'folder/deep/b'), 'utf8')).toBe('3456')
    expect((await f.files.listTrash()).totalBytes).toBe(3)
    expect(trashIds).toHaveLength(2)
  })
  test('does not overwrite an existing file or directory; supports a different destination', async () => {
    const f = await fixture(); await f.write('same.txt', 'original')
    const { trashIds: [id] } = await f.files.trash(['/same.txt']); await f.write('same.txt', 'current')
    await status(f.files.restoreTrash(id), 409)
    expect(await fs.readFile(path.join(f.dataRoot, 'same.txt'), 'utf8')).toBe('current')
    expect(await f.files.restoreTrash(id, '/same (restored).txt')).toEqual({ ok: true, path: '/same (restored).txt' })
    expect(await fs.readFile(path.join(f.dataRoot, 'same (restored).txt'), 'utf8')).toBe('original')
    await f.write('folder/a', 'A'); const { trashIds: [folder] } = await f.files.trash(['/folder'])
    await fs.mkdir(path.join(f.dataRoot, 'folder'))
    await status(f.files.restoreTrash(folder), 409)
    expect(await fs.readdir(path.join(f.dataRoot, 'folder'))).toEqual([])
  })
  test('missing parents produce a clear error without silently creating directories', async () => {
    const f = await fixture(); await f.write('parent/file', 'keep')
    const { trashIds: [id] } = await f.files.trash(['/parent/file']); await fs.rmdir(path.join(f.dataRoot, 'parent'))
    await expect(f.files.restoreTrash(id)).rejects.toThrow('restore parent does not exist')
    await absent(path.join(f.dataRoot, 'parent'))
    expect((await f.files.listTrash()).entries[0]!.recoverable).toBe(true)
    await f.write('not-a-directory', 'file')
    await status(f.files.restoreTrash(id, '/not-a-directory/child'), 400)
  })
  test('rejects root, hidden, traversing, malformed and symlink destinations', async () => {
    const f = await fixture(); await f.write('file', 'keep')
    const { trashIds: [id] } = await f.files.trash(['/file'])
    const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret'), 'OUTSIDE')
    await fs.symlink(outside, path.join(f.dataRoot, 'link')); await fs.symlink(path.join(outside, 'secret'), path.join(f.dataRoot, 'leaf'))
    for (const target of ['/', '/../outside', '/.hidden', '/folder/.hidden', '/folder/../escape', '/back\\slash', '/link/new', '/leaf']) await status(f.files.restoreTrash(id, target), 400)
    for (const bad of ['../escape', '/absolute', 'a/b', 'a\\b', '.', '..', '', null]) await status(f.files.restoreTrash(bad), 400)
    expect(await fs.readFile(path.join(outside, 'secret'), 'utf8')).toBe('OUTSIDE')
    expect((await f.files.listTrash()).entries[0]!.recoverable).toBe(true)
  })
  test('damaged manifests and missing payloads remain visible but cannot be restored', async () => {
    const f = await fixture()
    await f.legacy('broken-json', '{broken'); await f.legacy('missing-manifest', null)
    await f.legacy('bad-path', { originalPath: '/../escape', deletedAt: 1 })
    await f.legacy('missing-content', { originalPath: '/gone', deletedAt: 1 }, null)
    await f.legacy('future-version', { version: 999, state: 'ready', originalPath: '/future', deletedAt: 1 })
    await f.legacy('hidden-original', { originalPath: '/folder/.secret', deletedAt: 1 })
    const result = await f.files.listTrash()
    expect(result.entries).toHaveLength(6); expect(result.incomplete).toBe(true)
    for (const item of result.entries) { expect(item.recoverable).toBe(false); expect(item.error).toBeTruthy(); await status(f.files.restoreTrash(item.id, '/safe'), 409) }
    expect(await fs.readdir(f.dataRoot)).toEqual([])
  })
  test('symbolic links are never followed or restored', async () => {
    const f = await fixture(); const outside = path.join(f.root, 'outside'); await fs.writeFile(outside, 'PRIVATE')
    const item = await f.legacy('linked', undefined, null); await fs.symlink(outside, path.join(item, 'content'))
    const result = await f.files.listTrash()
    expect(result.entries.every((entry) => !entry.recoverable)).toBe(true); expect(result.incomplete).toBe(true)
    await status(f.files.restoreTrash('linked'), 409)
    await f.files.purgeTrash({ ids: ['linked'], confirmation: 'DELETE' })
    expect(await fs.readFile(outside, 'utf8')).toBe('PRIVATE')
  })
  test('ordinary hidden descendants are counted and preserved when their visible parent is recycled', async () => {
    const f = await fixture(); await f.write('folder/visible', 'normal'); await f.write('folder/.DS_Store', 'metadata'); await f.write('folder/.git/config', 'git config')
    const { trashIds: [id] } = await f.files.trash(['/folder'])
    const result = await f.files.listTrash()
    expect(result.entries[0]!.recoverable).toBe(true); expect(result.totalBytes).toBe(24); expect(result.incomplete).toBe(false)
    await f.files.restoreTrash(id)
    expect(await fs.readFile(path.join(f.dataRoot, 'folder/.DS_Store'), 'utf8')).toBe('metadata')
    expect(await fs.readFile(path.join(f.dataRoot, 'folder/.git/config'), 'utf8')).toBe('git config')
    await status(f.files.resolve('/folder/.DS_Store'), 400)
    await status(f.files.trash(['/folder/.git']), 400)
  })
  test('trash rejects symlink source trees before moving any member of a batch', async () => {
    const f = await fixture(); await f.write('safe', 'safe'); await f.write('folder/normal', 'data')
    await fs.symlink(path.join(f.dataRoot, 'safe'), path.join(f.dataRoot, 'folder/link'))
    await status(f.files.trash(['/safe', '/folder']), 400)
    expect(await fs.readFile(path.join(f.dataRoot, 'safe'), 'utf8')).toBe('safe')
    expect((await f.files.listTrash()).entries).toEqual([])
  })
})

describe('permanent deletion and a shared consistency lock', () => {
  test('requires exact confirmation and validates the entire batch before deleting', async () => {
    const f = await fixture(); await f.legacy('one'); await f.legacy('two'); await f.legacy('three')
    for (const request of [null, {}, { ids: ['one'] }, { ids: ['one'], confirmation: 'delete' }, { all: true, confirmation: 'DELETE' }, { all: 'true', confirmation: 'EMPTY_TRASH' }, { all: true, ids: ['one'], confirmation: 'EMPTY_TRASH' }, { ids: ['../outside'], confirmation: 'DELETE' }, { ids: [], confirmation: 'DELETE' }]) await status(f.files.purgeTrash(request), 400)
    await status(f.files.purgeTrash({ ids: ['one', 'missing'], confirmation: 'DELETE' }), 404)
    expect((await f.files.listTrash()).entries).toHaveLength(3)
    expect(await f.files.purgeTrash({ ids: ['one', 'one', 'two'], confirmation: 'DELETE' })).toEqual({ ok: true, purged: 2 })
    expect((await f.files.listTrash()).entries.map((entry) => entry.id)).toEqual(['three'])
    expect(await f.files.purgeTrash({ all: true, confirmation: 'EMPTY_TRASH' })).toEqual({ ok: true, purged: 1 })
    expect(await f.files.purgeTrash({ all: true, confirmation: 'EMPTY_TRASH' })).toEqual({ ok: true, purged: 0 })
  })
  test('purging a damaged link removes only the link; a symlink trash root is rejected', async () => {
    const f = await fixture(); const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'keep'), 'keep')
    await fs.mkdir(path.join(f.stateRoot, 'trash')); await fs.symlink(outside, path.join(f.stateRoot, 'trash/broken-link'))
    expect((await f.files.listTrash()).entries[0]!.recoverable).toBe(false)
    await f.files.purgeTrash({ ids: ['broken-link'], confirmation: 'DELETE' })
    expect(await fs.readFile(path.join(outside, 'keep'), 'utf8')).toBe('keep')
    await fs.rmdir(path.join(f.stateRoot, 'trash')); await fs.symlink(outside, path.join(f.stateRoot, 'trash'))
    await status(f.files.listTrash(), 400); await status(f.files.purgeTrash({ all: true, confirmation: 'EMPTY_TRASH' }), 400)
    expect(await fs.readFile(path.join(outside, 'keep'), 'utf8')).toBe('keep')
  })
  test('partial permanent deletion reports failed ids, continues the batch, and supports a fresh retry', async () => {
    let fail = true
    const f = await fixture(({ stateRoot }) => ({ rm: async (target, options) => { if (fail && String(target) === path.join(stateRoot, 'trash/two')) throw denied(); return fs.rm(target, options) } }))
    await f.legacy('one'); await f.legacy('two'); await f.legacy('three')
    const result = await f.files.purgeTrash({ ids: ['one', 'two', 'three'], confirmation: 'DELETE' })
    expect(result.ok).toBe(false); expect(result.purged).toBe(2); expect(result.failed?.map((item) => item.id)).toEqual(['two'])
    expect(result.failed?.[0]!.error).not.toContain(f.stateRoot)
    expect(await fs.readFile(path.join(f.stateRoot, 'trash/two/content'), 'utf8')).toBe('legacy')
    const remaining = await f.files.listTrash(); expect(remaining.entries.map((entry) => entry.id)).toEqual(['two'])
    expect(remaining.entries[0]!.recoverable).toBe(false)
    fail = false
    expect(await f.files.purgeTrash({ ids: ['two'], confirmation: 'DELETE' })).toEqual({ ok: true, purged: 1 })
  })
  test('an interrupted recursive purge cannot leave a partly deleted tree marked recoverable', async () => {
    const f = await fixture(({ stateRoot }) => ({ rm: async (target, options) => {
      if (path.dirname(String(target)) === path.join(stateRoot, 'trash')) {
        await fs.rm(path.join(String(target), 'content/a')); throw denied()
      }
      return fs.rm(target, options)
    } }))
    await f.write('folder/a', 'A'); await f.write('folder/b', 'B')
    const { trashIds: [id] } = await f.files.trash(['/folder'])
    const result = await f.files.purgeTrash({ ids: [id], confirmation: 'DELETE' })
    expect(result.ok).toBe(false); expect(result.purged).toBe(0)
    expect((await f.files.listTrash()).entries[0]!.recoverable).toBe(false)
    expect(await fs.readFile(path.join(f.stateRoot, 'trash', id!, 'content/b'), 'utf8')).toBe('B')
    await status(f.files.restoreTrash(id), 409)
  })
  test('snapshot waits for an upload and blocks queued mutations until the copy is finished', async () => {
    const f = await fixture(); let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
    const upload = f.files.upload('/', 'upload', body)
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>((resolve) => { enter = resolve }), gate = new Promise<void>((resolve) => { release = resolve })
    const snapshot = f.files.withSnapshot(async () => { enter(); expect(await fs.readFile(path.join(f.dataRoot, 'upload'), 'utf8')).toBe('complete'); await gate; expect(await fs.readdir(f.dataRoot)).toEqual(['upload']) })
    let mutationFinished = false
    const mkdir = f.files.mkdir('/after-snapshot').then(() => { mutationFinished = true })
    controller.enqueue(new TextEncoder().encode('complete')); controller.close()
    await upload; await entered; expect(mutationFinished).toBe(false)
    release(); await snapshot; await mkdir; expect(mutationFinished).toBe(true)
  })
  test('restore and purge participate in the same snapshot boundary', async () => {
    const f = await fixture(); await f.legacy('restore-me'); await f.legacy('purge-me')
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>((resolve) => { enter = resolve }), gate = new Promise<void>((resolve) => { release = resolve })
    const snapshot = f.files.withSnapshot(async () => { enter(); await gate; expect(await fs.readdir(path.join(f.stateRoot, 'trash'))).toHaveLength(2) })
    await entered
    const restore = f.files.restoreTrash('restore-me'), purge = f.files.purgeTrash({ ids: ['purge-me'], confirmation: 'DELETE' })
    await Promise.resolve(); await absent(path.join(f.dataRoot, 'legacy.txt'))
    release(); await snapshot; await restore; await purge
    expect((await f.files.listTrash()).entries).toEqual([])
  })
})

describe('cross-volume moves and failure recovery', () => {
  test('a later batch failure clearly reports earlier items already moved into the recycle bin', async () => {
    const f = await fixture(({ dataRoot }) => ({ rename: async (from, to) => { if (String(from) === path.join(dataRoot, 'two')) throw denied(); return fs.rename(from, to) } }))
    await f.write('one', 'ONE'); await f.write('two', 'TWO')
    await expect(f.files.trash(['/one', '/two'])).rejects.toThrow('some items were moved to the recycle bin')
    await absent(path.join(f.dataRoot, 'one')); expect(await fs.readFile(path.join(f.dataRoot, 'two'), 'utf8')).toBe('TWO')
    const result = await f.files.listTrash()
    expect(result.entries.find((entry) => entry.originalPath === '/one')!.recoverable).toBe(true)
    expect(result.entries.find((entry) => entry.originalPath === '/two')!.recoverable).toBe(false)
  })
  test('a target created during restoration is never overwritten', async () => {
    const f = await fixture(({ stateRoot }) => ({ link: async (from, to) => {
      if (String(from).startsWith(stateRoot + path.sep)) await fs.writeFile(String(to), 'NEW CONCURRENT FILE')
      return fs.link(from, to)
    } }))
    await f.write('file', 'ORIGINAL'); const { trashIds: [id] } = await f.files.trash(['/file'])
    await status(f.files.restoreTrash(id), 409)
    expect(await fs.readFile(path.join(f.dataRoot, 'file'), 'utf8')).toBe('NEW CONCURRENT FILE')
    expect(await fs.readFile(path.join(f.stateRoot, 'trash', id!, 'content'), 'utf8')).toBe('ORIGINAL')
  })
  test('recycles files and directories through a verified hidden staging copy', async () => {
    const f = await fixture(({ dataRoot }) => ({ rename: async (from, to) => { if (String(from).startsWith(dataRoot + path.sep)) throw crossDevice(); return fs.rename(from, to) } }))
    await f.write('file', 'exact content'); await f.write('folder/nested/file', 'nested content')
    const { trashIds } = await f.files.trash(['/file', '/folder'])
    expect(await fs.readdir(f.dataRoot)).toEqual([])
    const result = await f.files.listTrash(); expect(result.totalBytes).toBe(27); expect(result.entries.every((entry) => entry.recoverable)).toBe(true)
    for (const id of trashIds) {
      const names = (await fs.readdir(path.join(f.stateRoot, 'trash', id))).sort()
      expect(names).toEqual(['content', 'manifest.json'])
      expect(JSON.parse(await fs.readFile(path.join(f.stateRoot, 'trash', id, 'manifest.json'), 'utf8')).state).toBe('ready')
    }
  })
  test('a partial copy failure leaves the source untouched and cannot appear recoverable', async () => {
    const f = await fixture(({ dataRoot }) => ({
      rename: async (from, to) => { if (String(from).startsWith(dataRoot + path.sep)) throw crossDevice(); return fs.rename(from, to) },
      cp: async (_source, destination) => { await fs.writeFile(String(destination), 'partial'); throw denied() },
    }))
    await f.write('file', 'ORIGINAL COMPLETE')
    await expect(f.files.trash(['/file'])).rejects.toThrow('permission denied')
    expect(await fs.readFile(path.join(f.dataRoot, 'file'), 'utf8')).toBe('ORIGINAL COMPLETE')
    const result = await f.files.listTrash(); expect(result.entries).toHaveLength(1); expect(result.entries[0]!.recoverable).toBe(false)
    expect(result.entries[0]!.error).toContain('incomplete')
  })
  test('same-size copy corruption is detected before publication or source removal', async () => {
    const f = await fixture(({ dataRoot }) => ({
      rename: async (from, to) => { if (String(from).startsWith(dataRoot + path.sep)) throw crossDevice(); return fs.rename(from, to) },
      cp: async (source, destination, options) => { await fs.cp(source, destination, options); await fs.writeFile(String(destination), 'CORRUPT!') },
    }))
    await f.write('file', 'ORIGINAL')
    await status(f.files.trash(['/file']), 409)
    expect(await fs.readFile(path.join(f.dataRoot, 'file'), 'utf8')).toBe('ORIGINAL')
    expect((await f.files.listTrash()).entries[0]!.recoverable).toBe(false)
  })
  test('source deletion failure retains a complete recoverable copy as well as the original', async () => {
    const f = await fixture(({ dataRoot }) => ({
      rename: async (from, to) => { if (String(from).startsWith(dataRoot + path.sep)) throw crossDevice(); return fs.rename(from, to) },
      rm: async (target, options) => { if (String(target) === path.join(dataRoot, 'file')) throw denied(); return fs.rm(target, options) },
    }))
    await f.write('file', 'COMPLETE')
    await expect(f.files.trash(['/file'])).rejects.toThrow('permission denied')
    expect(await fs.readFile(path.join(f.dataRoot, 'file'), 'utf8')).toBe('COMPLETE')
    const result = await f.files.listTrash(); expect(result.entries[0]!.recoverable).toBe(true)
    await f.files.restoreTrash(result.entries[0]!.id, '/recovered')
    expect(await fs.readFile(path.join(f.dataRoot, 'recovered'), 'utf8')).toBe('COMPLETE')
  })
  test('restores a cross-volume file and directory atomically without staging leftovers', async () => {
    const f = await fixture(({ stateRoot }) => ({
      link: async (from, to) => { if (String(from).startsWith(stateRoot + path.sep)) throw crossDevice(); return fs.link(from, to) },
      rename: async (from, to) => { if (String(from).startsWith(stateRoot + path.sep) && !String(to).startsWith(stateRoot + path.sep)) throw crossDevice(); return fs.rename(from, to) },
    }))
    await f.write('file', 'DATA'); await f.write('folder/nested', 'FOLDER')
    const { trashIds } = await f.files.trash(['/file', '/folder'])
    for (const id of trashIds) await f.files.restoreTrash(id)
    expect(await fs.readFile(path.join(f.dataRoot, 'file'), 'utf8')).toBe('DATA'); expect(await fs.readFile(path.join(f.dataRoot, 'folder/nested'), 'utf8')).toBe('FOLDER')
    expect((await fs.readdir(f.dataRoot)).sort()).toEqual(['file', 'folder']); expect((await f.files.listTrash()).entries).toEqual([])
  })
  test('failed cross-volume restoration never publishes partial data or removes recycled content', async () => {
    const f = await fixture(({ stateRoot }) => ({
      link: async (from, to) => { if (String(from).startsWith(stateRoot + path.sep)) throw crossDevice(); return fs.link(from, to) },
      cp: async (_source, destination) => { await fs.writeFile(String(destination), 'partial'); throw denied() },
    }))
    await f.write('file', 'COMPLETE'); const { trashIds: [id] } = await f.files.trash(['/file'])
    await expect(f.files.restoreTrash(id)).rejects.toThrow('permission denied')
    expect(await fs.readdir(f.dataRoot)).toEqual([])
    expect(await fs.readFile(path.join(f.stateRoot, 'trash', id!, 'content'), 'utf8')).toBe('COMPLETE')
    expect((await f.files.listTrash()).entries[0]!.recoverable).toBe(true)
  })
  test('cleanup failure after successful publication returns success with a warning', async () => {
    let fail = false
    const f = await fixture(({ stateRoot }) => ({ rm: async (target, options) => { if (fail && path.dirname(String(target)) === path.join(stateRoot, 'trash')) throw denied(); return fs.rm(target, options) } }))
    await f.write('file', 'COMPLETE'); const { trashIds: [id] } = await f.files.trash(['/file']); fail = true
    const restored = await f.files.restoreTrash(id)
    expect(restored.ok).toBe(true); expect(restored.warning).toContain('cleanup')
    expect(await fs.readFile(path.join(f.dataRoot, 'file'), 'utf8')).toBe('COMPLETE')
    expect((await f.files.listTrash()).entries[0]!.recoverable).toBe(true)
  })
})
