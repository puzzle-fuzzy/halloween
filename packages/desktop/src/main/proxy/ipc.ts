import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { ClashProxy } from '../proxy-parse'
import { uniqueNames } from '../proxy-parse'
import type { ProxySubscription } from './config'
import { cachedNodeCount, config, loadConfig, saveConfig } from './config'
import { coreApi, GROUP, startCore, stopCore } from './core'
import { state } from './state'
import { collectProxies, fetchSubscription } from './subscription'
import { setSystemProxy } from './sysproxy'
import { setWindowProvider } from './traffic'
import { installTunTask, taskExists } from './tun'

const DELAY_TEST_URL = 'https://www.gstatic.com/generate_204'
/** sys-proxy works on windows (registry) and macos (networksetup); TUN needs windows elevation */
const SUPPORTED = process.platform === 'win32' || process.platform === 'darwin'
const TUN_SUPPORTED = process.platform === 'win32'

function publicState() {
  return {
    supported: SUPPORTED,
    tunSupported: TUN_SUPPORTED,
    running: state.running,
    busy: state.busy,
    sysProxy: state.sysProxy,
    mode: config.mode,
    tunReady: state.tunReady,
    mixedPort: state.mixedPort,
    subscriptions: config.subscriptions,
    nodeCount: cachedNodeCount(),
    /** node names from the last successful fetch — shown before the core runs */
    cachedNodes: uniqueNames(Object.values(config.subNodes).flat() as ClashProxy[]).map(
      (p) => p.name,
    ),
    lastError: state.lastError,
  }
}

interface CoreProxies {
  proxies: Record<
    string,
    { type: string; now?: string; all?: string[]; history?: { delay: number }[] }
  >
}

async function readNodes(): Promise<{
  current: string
  nodes: { name: string; delay: number }[]
}> {
  const res = await coreApi<CoreProxies>('/proxies')
  const group = res.proxies[GROUP]
  if (!group?.all) return { current: '', nodes: [] }
  const delays = new Map<string, number>()
  for (const [name, info] of Object.entries(res.proxies)) {
    const last = info.history?.[info.history.length - 1]?.delay
    if (last) delays.set(name, last)
  }
  return {
    current: group.now ?? '',
    nodes: group.all.map((name) => ({ name, delay: delays.get(name) ?? 0 })),
  }
}

async function proxyEnable(): Promise<void> {
  await startCore()
  if (config.mode === 'sys') {
    await setSystemProxy(true)
  } else if (state.sysProxy) {
    // TUN takes over at the IP layer — a leftover system proxy would
    // pin browsers to our mixed port and bypass the adapter
    await setSystemProxy(false)
  }
}

async function proxyDisable(): Promise<void> {
  // always run the clear — it is ownership-aware and heals a half-set state
  await setSystemProxy(false)
  await stopCore()
}

export function registerProxyHandlers(getWindow: () => BrowserWindow | null): void {
  setWindowProvider(getWindow)
  // awaited by every handler — a proxy:* call right after app start must not
  // observe the pre-load default config
  const ready = loadConfig().then(async () => {
    state.tunReady = await taskExists()
  })

  ipcMain.handle('proxy:state', async () => {
    await ready
    state.tunReady = await taskExists()
    return publicState()
  })

  ipcMain.handle('proxy:enable', async () => {
    await ready
    if (!SUPPORTED) throw new Error('proxy is only supported on Windows and macOS')
    if (state.busy) return publicState()
    try {
      await proxyEnable()
    } catch (err) {
      if (err instanceof Error && err.message === 'tun-not-installed') {
        state.lastError =
          'tun-not-installed: register the elevated task first (Install Service button)'
      } else {
        state.lastError = err instanceof Error ? err.message : String(err)
      }
    }
    return publicState()
  })

  ipcMain.handle('proxy:disable', async () => {
    if (state.busy) return publicState()
    try {
      await proxyDisable()
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err)
    }
    return publicState()
  })

  ipcMain.handle('proxy:set-mode', async (_e, mode: 'sys' | 'tun') => {
    await ready
    if (!SUPPORTED) throw new Error('proxy is only supported on Windows and macOS')
    if (mode !== 'sys' && mode !== 'tun') throw new Error('invalid mode')
    if (mode === 'tun' && !TUN_SUPPORTED) throw new Error('TUN mode is only supported on Windows')
    const wasRunning = state.running
    if (wasRunning) await proxyDisable()
    config.mode = mode
    await saveConfig()
    if (wasRunning) await proxyEnable()
    return publicState()
  })

  ipcMain.handle('proxy:install-tun', async () => {
    if (!TUN_SUPPORTED) throw new Error('TUN mode is only supported on Windows')
    await installTunTask()
    state.tunReady = await taskExists()
    return publicState()
  })

  ipcMain.handle('proxy:subs:add', async (_e, url: string) => {
    await ready
    const clean = url.trim()
    if (!/^https?:\/\//i.test(clean)) {
      throw new Error('a valid http(s) subscription URL is required')
    }
    // validate + count immediately so the user gets instant feedback
    const nodes = await fetchSubscription(clean)
    const sub: ProxySubscription = {
      id: randomUUID(),
      name: new URL(clean).hostname,
      url: clean,
      updatedAt: Date.now(),
      nodeCount: nodes.length,
    }
    config.subscriptions.push(sub)
    config.subNodes[sub.id] = nodes
    await saveConfig()
    return publicState()
  })

  ipcMain.handle('proxy:subs:delete', async (_e, id: string) => {
    await ready
    config.subscriptions = config.subscriptions.filter((s) => s.id !== id)
    delete config.subNodes[id]
    await saveConfig()
    return publicState()
  })

  ipcMain.handle('proxy:subs:update', async (_e, id: string) => {
    await ready
    if (!config.subscriptions.some((s) => s.id === id)) throw new Error('unknown subscription')
    if (state.running) {
      // startCore refetches everything and rewrites the config
      await stopCore()
      await startCore()
    } else {
      await collectProxies()
    }
    return publicState()
  })

  ipcMain.handle('proxy:nodes', () => readNodes())

  ipcMain.handle('proxy:select', async (_e, name: string) => {
    await coreApi(`/proxies/${encodeURIComponent(GROUP)}`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    })
    return readNodes()
  })

  ipcMain.handle('proxy:test-all', async () => {
    // one call tests every node in the group
    await coreApi(
      `/group/${encodeURIComponent(GROUP)}/delay?url=${encodeURIComponent(DELAY_TEST_URL)}&timeout=5000`,
    )
    return readNodes()
  })
}
