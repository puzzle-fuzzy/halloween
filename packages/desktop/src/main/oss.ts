import { BrowserWindow, dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { apiJson, progressReporter, uniqueTarget } from './cloud'
import type { TransferProgress } from './cloud'

export interface OssAccountInfo {
  id: string
  name: string
  region: string
}

export interface OssBucketInfo {
  name: string
  region?: string
  createdAt: number
}

export interface OssEntry {
  name: string
  key: string
  type: 'dir' | 'file'
  size: number
  mtime: number
}

function countedStream(
  filePath: string,
  id: string,
  name: string,
  total: number,
  report: { push: (p: TransferProgress) => void }
): ReadableStream<Uint8Array> {
  const nodeStream = fs.createReadStream(filePath)
  let loaded = 0
  const web = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>
  return web.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        loaded += chunk.byteLength
        report.push({ id, kind: 'upload', name, loaded, total })
        controller.enqueue(chunk)
      },
    })
  )
}

/** upload directly to OSS with a server-signed PUT url — no server bandwidth */
async function uploadFiles(
  accountId: string,
  bucket: string,
  prefix: string,
  localPaths: string[]
): Promise<{ name: string; size: number }[]> {
  const uploaded: { name: string; size: number }[] = []
  for (const local of localPaths) {
    const name = path.basename(local)
    const key = prefix + name
    const { size } = await fsp.stat(local)
    const { url } = await apiJson<{ url: string }>(
      `/oss/api/accounts/${accountId}/sign`,
      {
        method: 'POST',
        body: JSON.stringify({ bucket, key, method: 'PUT' }),
      }
    )
    const id = randomUUID()
    const report = progressReporter()
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: countedStream(local, id, name, size, report),
      duplex: 'half',
    })
    report.flush()
    if (!res.ok) {
      throw new Error(`Upload failed for ${name}: HTTP ${res.status}`.slice(0, 200))
    }
    uploaded.push({ name, size })
  }
  return uploaded
}

export function registerOssHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('oss:accounts', () => apiJson<{ accounts: OssAccountInfo[] }>('/oss/api/accounts'))

  ipcMain.handle('oss:buckets', (_e, accountId: string) =>
    apiJson<{ buckets: OssBucketInfo[] }>(`/oss/api/accounts/${accountId}/buckets`)
  )

  ipcMain.handle('oss:objects', (_e, accountId: string, bucket: string, prefix: string) =>
    apiJson<{ entries: OssEntry[]; truncated: boolean }>(
      `/oss/api/accounts/${accountId}/objects?bucket=${encodeURIComponent(bucket)}&prefix=${encodeURIComponent(prefix)}`
    )
  )

  ipcMain.handle('oss:preview-url', (_e, accountId: string, bucket: string, key: string) =>
    apiJson<{ url: string }>('/oss/api/accounts/' + accountId + '/sign', {
      method: 'POST',
      body: JSON.stringify({ bucket, key, method: 'GET' }),
    })
  )

  ipcMain.handle('oss:mkdir', (_e, accountId: string, bucket: string, key: string) =>
    apiJson(`/oss/api/accounts/${accountId}/mkdir`, {
      method: 'POST',
      body: JSON.stringify({ bucket, key }),
    })
  )

  ipcMain.handle('oss:rename', (_e, accountId: string, bucket: string, from: string, to: string) =>
    apiJson(`/oss/api/accounts/${accountId}/rename`, {
      method: 'POST',
      body: JSON.stringify({ bucket, from, to }),
    })
  )

  ipcMain.handle('oss:delete', (_e, accountId: string, bucket: string, keys: string[]) =>
    apiJson(`/oss/api/accounts/${accountId}/delete`, {
      method: 'POST',
      body: JSON.stringify({ bucket, keys }),
    })
  )

  ipcMain.handle(
    'oss:pick-and-upload',
    async (_e, accountId: string, bucket: string, prefix: string) => {
      const win = getWindow()
      if (!win) return []
      const picked = await dialog.showOpenDialog(win, {
        properties: ['openFile', 'multiSelections'],
      })
      if (picked.canceled || picked.filePaths.length === 0) return []
      return uploadFiles(accountId, bucket, prefix, picked.filePaths)
    }
  )

  ipcMain.handle(
    'oss:upload-files',
    (_e, accountId: string, bucket: string, prefix: string, localPaths: string[]) =>
      uploadFiles(accountId, bucket, prefix, localPaths)
  )

  ipcMain.handle(
    'oss:download-to',
    async (_e, accountId: string, bucket: string, key: string, name: string, targetDir: string) => {
      const { url } = await apiJson<{ url: string }>('/oss/api/accounts/' + accountId + '/sign', {
        method: 'POST',
        body: JSON.stringify({ bucket, key, method: 'GET' }),
      })
      const res = await fetch(url)
      if (!res.ok || !res.body) throw new Error(`Download failed for ${name}: HTTP ${res.status}`)
      const id = randomUUID()
      const total = Number(res.headers.get('content-length') ?? 0)
      const target = uniqueTarget(targetDir, name)
      const out = fs.createWriteStream(target)
      const report = progressReporter()
      const reader = res.body.getReader()
      let loaded = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          loaded += value.byteLength
          out.write(value)
          report.push({ id, kind: 'download', name, loaded, total })
        }
      }
      await new Promise<void>((resolve) => out.end(resolve))
      report.flush()
      return target
    }
  )
}
