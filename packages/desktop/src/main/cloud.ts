import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import os from 'node:os'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { applyServerOverride, createConfigStore, type CloudConfig } from './config-store'
import { downloadFile } from './download'
import { transfers } from './transfers'
import { parseDevicePoll, SignInAttempt, verifySignIn } from './auth'
import type { TrashListing, TrashPurgeInput, TrashRestoreResult, TrashPurgeResult, BackupStatus, BackupJob, BackupStartInput } from '@halloween/contracts'
export type { TransferProgress } from './transfers'
export { DEFAULT_SERVER_URL } from './config-store'

import type { FileEntry as CloudEntry } from '@halloween/contracts/files'
export type { CloudEntry }

let getWin: () => BrowserWindow | null = () => null
const signIn = new SignInAttempt()
const tokenCipher = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (value: string) => safeStorage.encryptString(value),
  decryptString: (value: Buffer) => safeStorage.decryptString(value),
  getSelectedStorageBackend: () => process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'native',
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'cloud-config.json')
}

async function getConfig(): Promise<CloudConfig> {
  const config = await createConfigStore(configPath(), tokenCipher).load()
  return applyServerOverride(config, app.isPackaged ? undefined : process.env.HALLOWEEN_SERVER_URL)
}

async function saveConfig(config: CloudConfig): Promise<void> {
  await createConfigStore(configPath(), tokenCipher).save(config)
}

function assertConfigured(config: CloudConfig): void {
  if (!config.serverUrl || !config.token) {
    throw new Error('Sign in to use the cloud drive.')
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

export { apiJson, getConfig }

function encodeRemotePath(rel: string): string {
  return rel
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
}

function remoteFileUrl(config: CloudConfig, rel: string): string {
  return `${config.serverUrl}/f/${encodeRemotePath(rel)}`
}

function countedUploadStream(
  filePath: string,
  id: string,
  total: number,
): ReadableStream<Uint8Array> {
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
    })
  )
}

async function uploadFiles(localPaths: string[], remoteDir: string): Promise<{ name: string; size: number }[]> {
  const config = await getConfig()
  assertConfigured(config)
  const uploaded: { name: string; size: number }[] = []
  for (const local of localPaths) {
    const name = path.basename(local)
    const id = transfers.start('upload', name)
    const signal = transfers.signal(id)
    try {
      const { size } = await fsp.stat(local)
      transfers.progress(id, 0, size)
      const url = `${config.serverUrl}/api/upload?path=${encodeURIComponent(remoteDir)}&name=${encodeURIComponent(name)}`
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.token}` },
        body: countedUploadStream(local, id, size),
        duplex: 'half',
        signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Upload failed for ${name}: HTTP ${res.status} ${text}`.slice(0, 200))
      }
      uploaded.push({ name, size })
      transfers.complete(id)
    } catch (error) {
      transfers.fail(id, error)
      throw error
    }
  }
  return uploaded
}

export function registerCloudHandlers(getWindow: () => BrowserWindow | null): void {
  getWin = getWindow
  transfers.notify = (progress) => getWin()?.webContents.send('cloud:progress', progress)
  ipcMain.handle('cloud:transfers', () => transfers.list())
  ipcMain.handle('cloud:cancel-transfer', (_e, id: string) => transfers.cancel(id))
  ipcMain.handle('cloud:open-admin', async (_e, page: string = 'profile') => {
    if (!['profile', 'tokens', 'oss-accounts'].includes(page)) throw new Error('Unknown administration page')
    const url = new URL((await getConfig()).serverUrl)
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid server URL')
    await shell.openExternal(`${url.origin}/admin/#/${page}`)
  })

  ipcMain.handle('cloud:login', () => signIn.run(async (signal) => {
    const config = await getConfig()
    signal.throwIfAborted()
    const api = async (pathname: string, init?: RequestInit) =>
      fetch(config.serverUrl + pathname, {
        ...init,
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      })
    const codeRes = await api('/api/device/code', {
      method: 'POST',
      body: JSON.stringify({ name: os.hostname() }),
    })
    if (!codeRes.ok) throw new Error(`Failed to start sign-in (HTTP ${codeRes.status})`)
    const device = (await codeRes.json()) as {
      device_code: string
      user_code: string
      verify_url: string
      expires_in: number
    }
    if (!device.device_code || !device.user_code || !Number.isFinite(device.expires_in) || device.expires_in <= 0) throw new Error('The server returned an invalid device code')
    const deadline = Date.now() + Math.min(device.expires_in, 600) * 1000
    getWin()?.webContents.send('cloud:auth-code', { userCode: device.user_code, expiresAt: deadline })
    const verification = new URL(device.verify_url)
    if (!['https:', 'http:'].includes(verification.protocol) || verification.origin !== new URL(config.serverUrl).origin) {
      throw new Error('The server returned an invalid verification URL')
    }
    await shell.openExternal(verification.toString())
    for (;;) {
      await delay(3000, undefined, { signal })
      if (Date.now() > deadline) throw new Error('Sign-in timed out')
      const tokenRes = await api('/api/device/token', {
        method: 'POST',
        body: JSON.stringify({ device_code: device.device_code }),
      })
      const result = tokenRes.ok ? await tokenRes.json() as { status: string; token?: string } : undefined
      const token = parseDevicePoll(tokenRes.status, result)
      if (token) {
        signal.throwIfAborted()
        await saveConfig({ serverUrl: config.serverUrl, token })
        return { ok: true }
      }
    }
  }))

  ipcMain.handle('cloud:logout', () => signIn.cancel(async () => {
    const config = await getConfig()
    await saveConfig({ serverUrl: config.serverUrl, token: '' })
  }))

  ipcMain.handle('cloud:is-authed', async () => {
    const config = await getConfig()
    const valid = await verifySignIn(config)
    if (!valid && config.token) await saveConfig({ ...config, token: '' })
    return valid
  })

  ipcMain.handle('cloud:profile', () =>
    apiJson<{ profile: { name: string; email: string; avatar: string } }>('/api/profile')
  )

  ipcMain.handle('cloud:list', (_e, dir: string) =>
    apiJson<{ entries: CloudEntry[] }>(`/api/files?path=${encodeURIComponent(dir)}`)
  )
  ipcMain.handle('cloud:list-trash', () => apiJson<TrashListing>('/api/trash'))
  ipcMain.handle('cloud:restore-trash', (_e, id: string, destination?: string) =>
    apiJson<TrashRestoreResult>('/api/trash/restore', { method: 'POST', body: JSON.stringify({ id, destination }) })
  )
  ipcMain.handle('cloud:purge-trash', (_e, input: TrashPurgeInput) =>
    apiJson<TrashPurgeResult>('/api/trash/purge', { method: 'POST', body: JSON.stringify(input) })
  )
  ipcMain.handle('cloud:backup-status', () => apiJson<BackupStatus>('/api/backups/status'))
  ipcMain.handle('cloud:start-backup-job', (_e, input: BackupStartInput) =>
    apiJson<BackupJob>('/api/backups/jobs', { method: 'POST', body: JSON.stringify(input) })
  )
  ipcMain.handle('cloud:backup-job', (_e, id: string) => apiJson<BackupJob>(`/api/backups/jobs/${encodeURIComponent(id)}`))
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
    const { url } = await apiJson<{ url: string }>('/api/preview-ticket', {
      method: 'POST', body: JSON.stringify({ path: remotePath }),
    })
    return url
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
      const id = transfers.start('download', name)
      try {
        const target = await downloadFile({
          url: remoteFileUrl(config, remotePath), headers: { Authorization: `Bearer ${config.token}` },
          name, targetDir, onProgress: (loaded, total) => transfers.progress(id, loaded, total),
          signal: transfers.signal(id),
        })
        transfers.complete(id)
        return target
      } catch (error) {
        transfers.fail(id, error)
        throw error
      }
    }
  )
}
