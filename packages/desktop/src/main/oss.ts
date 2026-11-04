import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { OssAccountInfo, OssBucketInfo, OssEntry } from '@halloween/contracts/oss'
import { type BrowserWindow, dialog, ipcMain } from 'electron'
import { getConfig } from './cloud'
import { downloadFile } from './download'
import { transfers } from './transfers'

export type { OssAccountInfo, OssBucketInfo, OssEntry }

/** OSS API lives at <site-origin>/oss — NOT under the cloud serverUrl prefix */
async function ossApiJson<T>(pathname: string, init?: RequestInit): Promise<T> {
  const config = await getConfig()
  if (!config.serverUrl || !config.token) {
    throw new Error('OSS is not available. Sign in from the OSS or cloud drive page first.')
  }
  const base = new URL(config.serverUrl).origin
  const res = await fetch(base + pathname, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${text}`.slice(0, 200))
  }
  return res.json() as Promise<T>
}

function countedStream(filePath: string, id: string, total: number): ReadableStream<Uint8Array> {
  const nodeStream = fs.createReadStream(filePath)
  let loaded = 0
  const web = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>
  return web.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        loaded += chunk.byteLength
        transfers.progress(id, loaded, total)
        controller.enqueue(chunk)
      },
    }),
  )
}

/** upload directly to OSS with a server-signed PUT url — no server bandwidth */
async function uploadFiles(
  accountId: string,
  bucket: string,
  prefix: string,
  localPaths: string[],
): Promise<{ name: string; size: number }[]> {
  const uploaded: { name: string; size: number }[] = []
  for (const local of localPaths) {
    const name = path.basename(local)
    const id = transfers.start('upload', name)
    const signal = transfers.signal(id)
    try {
      const key = prefix + name
      const { size } = await fsp.stat(local)
      transfers.progress(id, 0, size)
      const { url, headers } = await ossApiJson<{ url: string; headers?: Record<string, string> }>(
        `/oss/api/accounts/${accountId}/sign`,
        { method: 'POST', body: JSON.stringify({ bucket, key, method: 'PUT' }), signal },
      )
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', ...headers },
        body: countedStream(local, id, size),
        duplex: 'half',
        signal,
      })
      if (!res.ok) throw new Error(`Upload failed for ${name}: HTTP ${res.status}`.slice(0, 200))
      uploaded.push({ name, size })
      transfers.complete(id)
    } catch (error) {
      transfers.fail(id, error)
      throw error
    }
  }
  return uploaded
}

export function registerOssHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('oss:accounts', () =>
    ossApiJson<{ accounts: OssAccountInfo[] }>('/oss/api/accounts'),
  )

  ipcMain.handle('oss:buckets', (_e, accountId: string) =>
    ossApiJson<{ buckets: OssBucketInfo[] }>(`/oss/api/accounts/${accountId}/buckets`),
  )

  ipcMain.handle(
    'oss:objects',
    (_e, accountId: string, bucket: string, prefix: string, marker?: string) =>
      ossApiJson<{ entries: OssEntry[]; truncated: boolean; nextMarker?: string }>(
        `/oss/api/accounts/${accountId}/objects?bucket=${encodeURIComponent(bucket)}&prefix=${encodeURIComponent(prefix)}${marker ? `&marker=${encodeURIComponent(marker)}` : ''}`,
      ),
  )

  ipcMain.handle('oss:preview-url', (_e, accountId: string, bucket: string, key: string) =>
    ossApiJson<{ url: string }>(`/oss/api/accounts/${accountId}/sign`, {
      method: 'POST',
      body: JSON.stringify({ bucket, key, method: 'GET' }),
    }),
  )

  ipcMain.handle('oss:mkdir', (_e, accountId: string, bucket: string, key: string) =>
    ossApiJson(`/oss/api/accounts/${accountId}/mkdir`, {
      method: 'POST',
      body: JSON.stringify({ bucket, key }),
    }),
  )

  ipcMain.handle('oss:rename', (_e, accountId: string, bucket: string, from: string, to: string) =>
    ossApiJson(`/oss/api/accounts/${accountId}/rename`, {
      method: 'POST',
      body: JSON.stringify({ bucket, from, to }),
    }),
  )

  ipcMain.handle('oss:delete', (_e, accountId: string, bucket: string, keys: string[]) =>
    ossApiJson(`/oss/api/accounts/${accountId}/delete`, {
      method: 'POST',
      body: JSON.stringify({ bucket, keys }),
    }),
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
    },
  )

  ipcMain.handle(
    'oss:upload-files',
    (_e, accountId: string, bucket: string, prefix: string, localPaths: string[]) =>
      uploadFiles(accountId, bucket, prefix, localPaths),
  )

  ipcMain.handle(
    'oss:download-to',
    async (_e, accountId: string, bucket: string, key: string, name: string, targetDir: string) => {
      const id = transfers.start('download', name)
      const signal = transfers.signal(id)
      try {
        const { url } = await ossApiJson<{ url: string }>(`/oss/api/accounts/${accountId}/sign`, {
          method: 'POST',
          body: JSON.stringify({ bucket, key, method: 'GET' }),
          signal,
        })
        const target = await downloadFile({
          url,
          name,
          targetDir,
          signal,
          onProgress: (loaded, total) => transfers.progress(id, loaded, total),
        })
        transfers.complete(id)
        return target
      } catch (error) {
        transfers.fail(id, error)
        throw error
      }
    },
  )
}
