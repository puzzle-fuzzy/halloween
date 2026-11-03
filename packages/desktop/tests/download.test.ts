import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { downloadFile } from '../src/main/download'

const temporaryDirectories: string[] = []
async function directory() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'halloween-download-test-'))
  temporaryDirectories.push(dir)
  return dir
}
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))) })
const request = (body: BodyInit) => (async () => new Response(body))

test('publishes complete files without overwriting an existing file, even with concurrent downloads', async () => {
  const dir = await directory()
  await fs.writeFile(path.join(dir, 'film.mp4'), 'original')
  const contents = 'x'.repeat(400_000)
  const options = { url: 'https://example.invalid/file', name: 'film.mp4', targetDir: dir, request: request(contents), onProgress: () => {} }
  const targets = await Promise.all([downloadFile(options), downloadFile(options)])
  expect(new Set(targets).size).toBe(2)
  expect(await fs.readFile(path.join(dir, 'film.mp4'), 'utf8')).toBe('original')
  for (const target of targets) expect(await fs.readFile(target, 'utf8')).toBe(contents)
  expect((await fs.readdir(dir)).filter((name) => name.endsWith('.part'))).toEqual([])
})

test('a broken response rejects and removes the partial file', async () => {
  const dir = await directory()
  let step = 0
  const broken = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (step++ === 0) controller.enqueue(new Uint8Array(65536))
      else controller.error(new Error('Connection interrupted'))
    },
  })
  await expect(downloadFile({ url: 'https://example.invalid/file', name: 'film.mp4', targetDir: dir,
    request: request(broken), onProgress: () => {} })).rejects.toThrow('Connection interrupted')
  expect(await fs.readdir(dir)).toEqual([])
})

test('a missing destination rejects instead of emitting an uncaught stream error', async () => {
  const dir = await directory()
  await expect(downloadFile({ url: 'https://example.invalid/file', name: 'file.txt', targetDir: path.join(dir, 'gone'),
    request: request('content'), onProgress: () => {} })).rejects.toThrow()
  expect(await fs.readdir(dir)).toEqual([])
})

test('remote names cannot escape the chosen destination', async () => {
  const dir = await directory()
  for (const name of ['../outside.txt', '..\\outside.txt', '..', '.']) {
    await expect(downloadFile({ url: 'https://example.invalid/file', name, targetDir: dir,
      request: request('content'), onProgress: () => {} })).rejects.toThrow('Invalid download filename')
  }
})

test('a failed fallback copy removes its partial final file and preserves existing files', async () => {
  const dir = await directory()
  await fs.writeFile(path.join(dir, 'file.txt'), 'original')
  await expect(downloadFile({ url: 'https://example.invalid/file', name: 'file.txt', targetDir: dir,
    request: request('complete response'), onProgress: () => {}, publication: {
      link: async () => { throw Object.assign(new Error('No hardlinks'), { code: 'EPERM' }) },
      copyFile: async (_source, target) => {
        await fs.writeFile(target, 'partial')
        throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' })
      },
    },
  })).rejects.toThrow('Disk full')
  expect(await fs.readdir(dir)).toEqual(['file.txt'])
  expect(await fs.readFile(path.join(dir, 'file.txt'), 'utf8')).toBe('original')
})

test('an incorrect response length cannot publish an apparently complete file', async () => {
  const dir = await directory()
  await expect(downloadFile({ url: 'https://example.invalid/file', name: 'file.txt', targetDir: dir,
    request: (async () => new Response('short', { headers: { 'content-length': '100' } })),
    onProgress: () => {},
  })).rejects.toThrow('Download incomplete')
  expect(await fs.readdir(dir)).toEqual([])
})

test('cancelling an active download aborts its stream and cleans its temporary file', async () => {
  const dir = await directory()
  const controller = new AbortController()
  const stream = new ReadableStream<Uint8Array>({ start(output) { output.enqueue(new Uint8Array(100)) } })
  const download = downloadFile({ url: 'https://example.invalid/file', name: 'file.txt', targetDir: dir,
    request: request(stream), signal: controller.signal, onProgress: () => controller.abort(),
  })
  await expect(download).rejects.toThrow()
  expect(await fs.readdir(dir)).toEqual([])
})
