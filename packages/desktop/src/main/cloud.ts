import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

export interface CloudConfig {
  serverUrl: string
  token: string
}

export interface CloudEntry {
  name: string
  type: 'dir' | 'file'
  size: number
  mtime: number
  path: string
}

export interface TransferProgress {
  id: string
  kind: 'upload' | 'download'
  name: string
  loaded: number
  total: number
}

let getWin: () => BrowserWindow | null = () => null

function configPath(): string {
  return path.join(app.getPath('userData'), 'cloud-config.json')
}

async function getConfig(): Promise<CloudConfig> {
  try {
    const raw = JSON.parse(await fsp.readFile(configPath(), 'utf-8')) as Partial<CloudConfig>
    return { serverUrl: raw.serverUrl ?? '', token: raw.token ?? '' }
  } catch {
    return { serverUrl: '', token: '' }
  }
}

async function saveConfig(config: CloudConfig): Promise<void> {
  config.serverUrl = config.serverUrl.replace(/\/+$/, '')
  await fsp.mkdir(path.dirname(configPath()), { recursive: true })
  await fsp.writeFile(configPath(), JSON.stringify(config, null, 2), 'utf-8')
}

function assertConfigured(config: CloudConfig): void {
  if (!config.serverUrl || !config.token) {
    throw new Error('云盘未配置，请先在设置中填写服务器地址和令牌')
  }
}

async function apiJson<T>(pathname: string, init?: RequestInit): Promise<T> {
  const config = await getConfig()
  assertConfigured(config)
  const res = await fetch(config.serverUrl + pathname, {
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

function encodeRemotePath(rel: string): string {
  return rel
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
}

function remoteFileUrl(config: CloudConfig, rel: string): string {
  return `${config.serverUrl}/f/${encodeRemotePath(rel)}?token=${encodeURIComponent(config.token)}`
}

function sendProgress(p: TransferProgress): void {
  getWin()?.webContents.send('cloud:progress', p)
}

function makeThrottler(): (p: TransferProgress) => void {
  let last = 0
  return (p) => {
    const now = Date.now()
    if (now - last > 300 || p.loaded >= p.total) {
      last = now
      sendProgress(p)
    }
  }
}

function countedUploadStream(
  filePath: string,
  id: string,
  name: string,
  total: number
): ReadableStream<Uint8Array> {
  const throttled = makeThrottler()
  const nodeStream = fs.createReadStream(filePath)
  let loaded = 0
  const web = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>
  return web.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        loaded += chunk.byteLength
        throttled({ id, kind: 'upload', name, loaded, total })
        controller.enqueue(chunk)
      },
    })
  )
}

async function uploadFiles(localPaths: string[], remoteDir: string): Promise<{ name: string; size: number }[]> {
  const config = await getConfig()
  assertConfigured(config)
  const uploaded: { name: string; size: number }[] = []
  for (const local of localPaths) {
    const name = path.basename(local)
    const { size } = await fsp.stat(local)
    const id = randomUUID()
    const url = `${config.serverUrl}/api/upload?path=${encodeURIComponent(remoteDir)}&name=${encodeURIComponent(name)}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}` },
      body: countedUploadStream(local, id, name, size),
      duplex: 'half',
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`上传 ${name} 失败: HTTP ${res.status} ${text}`.slice(0, 200))
    }
    uploaded.push({ name, size })
  }
  return uploaded
}

function uniqueTarget(dir: string, name: string): string {
  const ext = path.extname(name)
  const base = path.basename(name, ext)
  let target = path.join(dir, name)
  let i = 1
  while (fs.existsSync(target)) {
    target = path.join(dir, `${base} (${i})${ext}`)
    i++
  }
  return target
}

export function registerCloudHandlers(getWindow: () => BrowserWindow | null): void {
  getWin = getWindow

  ipcMain.handle('cloud:get-config', () => getConfig())
  ipcMain.handle('cloud:set-config', (_event, config: CloudConfig) => saveConfig(config))

  ipcMain.handle('cloud:list', (_e, dir: string) =>
    apiJson<{ entries: CloudEntry[] }>(`/api/files?path=${encodeURIComponent(dir)}`)
  )
  ipcMain.handle('cloud:mkdir', (_e, dir: string) =>
    apiJson('/api/mkdir', { method: 'POST', body: JSON.stringify({ path: dir }) })
  )
  ipcMain.handle('cloud:rename', (_e, from: string, to: string) =>
    apiJson('/api/rename', { method: 'POST', body: JSON.stringify({ from, to }) })
  )
  ipcMain.handle('cloud:delete', (_e, paths: string[]) =>
    apiJson('/api/delete', { method: 'POST', body: JSON.stringify({ paths }) })
  )
  ipcMain.handle('cloud:search', (_e, q: string) =>
    apiJson<{ entries: CloudEntry[] }>(`/api/search?q=${encodeURIComponent(q)}`)
  )

  ipcMain.handle('cloud:file-url', async (_e, remotePath: string) => {
    const config = await getConfig()
    assertConfigured(config)
    return remoteFileUrl(config, remotePath)
  })

  ipcMain.handle('cloud:pick-and-upload', async (_e, remoteDir: string) => {
    const win = getWin()
    if (!win) return []
    const picked = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
    })
    if (picked.canceled || picked.filePaths.length === 0) return []
    return uploadFiles(picked.filePaths, remoteDir)
  })

  ipcMain.handle('cloud:upload-files', (_e, localPaths: string[], remoteDir: string) =>
    uploadFiles(localPaths, remoteDir)
  )

  ipcMain.handle('cloud:choose-download-dir', async () => {
    const win = getWin()
    if (!win) return null
    const picked = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return picked.canceled ? null : picked.filePaths[0]
  })

  ipcMain.handle(
    'cloud:download-to',
    async (_e, remotePath: string, name: string, targetDir: string) => {
      const config = await getConfig()
      assertConfigured(config)
      const id = randomUUID()
      const res = await fetch(remoteFileUrl(config, remotePath))
      if (!res.ok || !res.body) {
        throw new Error(`下载 ${name} 失败: HTTP ${res.status}`)
      }
      const total = Number(res.headers.get('content-length') ?? 0)
      const target = uniqueTarget(targetDir, name)
      const out = fs.createWriteStream(target)
      const throttled = makeThrottler()
      const reader = res.body.getReader()
      let loaded = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          loaded += value.byteLength
          out.write(value)
          throttled({ id, kind: 'download', name, loaded, total })
        }
      }
      await new Promise<void>((resolve) => out.end(resolve))
      sendProgress({ id, kind: 'download', name, loaded, total: loaded })
      return target
    }
  )
}
