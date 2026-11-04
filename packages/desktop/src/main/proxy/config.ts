import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'

export interface ProxySubscription {
  id: string
  name: string
  url: string
  updatedAt: number
  nodeCount: number
}

export interface PersistedConfig {
  subscriptions: ProxySubscription[]
  secret: string
  /** last good nodes per subscription id — lets the core start when offline */
  subNodes: Record<string, unknown[]>
  /** 'sys' = system proxy (child process), 'tun' = virtual adapter (elevated task) */
  mode: 'sys' | 'tun'
}

/** persisted config — const object, mutated in place so every importer stays live */
export const config: PersistedConfig = { subscriptions: [], secret: '', subNodes: {}, mode: 'sys' }

export function workRoot(): string {
  return path.join(app.getPath('userData'), 'proxy')
}

export function binaryPath(): string {
  const dev = path.join(__dirname, '../../resources/mihomo.exe')
  if (fs.existsSync(dev)) return dev
  const prod = path.join(process.resourcesPath ?? '', 'mihomo.exe')
  if (fs.existsSync(prod)) return prod
  throw new Error(
    'mihomo.exe not found — run "bun scripts/ensure-mihomo.mjs" in packages/desktop (see resources/README.md)',
  )
}

function configFile(): string {
  return path.join(workRoot(), 'proxy-config.json')
}

function applyConfig(raw: Partial<PersistedConfig>): void {
  config.subscriptions = raw.subscriptions ?? []
  config.secret = raw.secret || randomBytes(16).toString('hex')
  config.subNodes = raw.subNodes ?? {}
  config.mode = raw.mode === 'tun' ? 'tun' : 'sys'
}

export async function loadConfig(): Promise<void> {
  try {
    const raw = JSON.parse(await fsp.readFile(configFile(), 'utf-8')) as Partial<PersistedConfig>
    applyConfig(raw)
    if (!raw.secret) await saveConfig()
  } catch {
    applyConfig({})
    await saveConfig()
  }
}

export async function saveConfig(): Promise<void> {
  await fsp.mkdir(workRoot(), { recursive: true })
  await fsp.writeFile(configFile(), JSON.stringify(config), 'utf-8')
}

export function cachedNodeCount(): number {
  return Object.values(config.subNodes).reduce((n, list) => n + list.length, 0)
}
