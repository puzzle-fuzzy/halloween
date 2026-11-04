import { spawn, execFile, execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { app, ipcMain, net as electronNet } from 'electron'
import type { BrowserWindow } from 'electron'
import { stringify as stringifyYaml } from 'yaml'
import { parseSubscriptionBody, uniqueNames } from './proxy-parse'
import type { ClashProxy } from './proxy-parse'

/** proxy group name everything is routed through */
const GROUP = '🚀 Node'
const FETCH_TIMEOUT_MS = 15_000
const CORE_START_TIMEOUT_MS = 10_000
const DELAY_TEST_URL = 'https://www.gstatic.com/generate_204'
/** system proxy (registry) and TUN (schtasks elevation) are windows-only machinery */
const SUPPORTED = process.platform === 'win32'

export interface ProxySubscription {
  id: string
  name: string
  url: string
  updatedAt: number
  nodeCount: number
}

interface PersistedConfig {
  subscriptions: ProxySubscription[]
  secret: string
  /** last good nodes per subscription id — lets the core start when offline */
  subNodes: Record<string, unknown[]>
  /** 'sys' = system proxy (child process), 'tun' = virtual adapter (elevated task) */
  mode: 'sys' | 'tun'
}

interface RuntimeState {
  running: boolean
  busy: boolean
  sysProxy: boolean
  mixedPort: number
  ctrlPort: number
  lastError: string
  tunReady: boolean
}

let config: PersistedConfig = { subscriptions: [], secret: '', subNodes: {}, mode: 'sys' }
let state: RuntimeState = {
  running: false,
  busy: false,
  sysProxy: false,
  mixedPort: 0,
  ctrlPort: 0,
  lastError: '',
  tunReady: false,
}
let core: ReturnType<typeof spawn> | null = null
let coreLog = ''
let stopping = false
let tunWatchdog: ReturnType<typeof setInterval> | null = null
let getWin: () => BrowserWindow | null = () => null
let trafficAbort: AbortController | null = null

// ------------------------------------------------------------------ storage

function workRoot(): string {
  return path.join(app.getPath('userData'), 'proxy')
}

function configFile(): string {
  return path.join(workRoot(), 'proxy-config.json')
}

async function loadConfig(): Promise<void> {
  try {
    const raw = JSON.parse(await fsp.readFile(configFile(), 'utf-8')) as Partial<PersistedConfig>
    config = {
      subscriptions: raw.subscriptions ?? [],
      secret: raw.secret || randomBytes(16).toString('hex'),
      subNodes: raw.subNodes ?? {},
      mode: raw.mode === 'tun' ? 'tun' : 'sys',
    }
    if (!raw.secret) await saveConfig()
  } catch {
    config = { subscriptions: [], secret: randomBytes(16).toString('hex'), subNodes: {}, mode: 'sys' }
    await saveConfig()
  }
}

async function saveConfig(): Promise<void> {
  await fsp.mkdir(workRoot(), { recursive: true })
  await fsp.writeFile(configFile(), JSON.stringify(config), 'utf-8')
}

function cachedNodeCount(): number {
  return Object.values(config.subNodes).reduce((n, list) => n + list.length, 0)
}

// ------------------------------------------------------------ subscription

/** airports pick the payload by client UA; some reject unknown ones with 403 */
const SUB_USER_AGENTS = [
  'clash-verge/2.5.8',
  'clash.meta/1.19.0',
  'ClashforWindows/0.20.39',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
]

async function fetchSubscription(url: string): Promise<ClashProxy[]> {
  let lastError: Error | null = null
  for (const ua of SUB_USER_AGENTS) {
    try {
      // net.fetch = chromium network stack: browser TLS fingerprint, so
      // cloudflare-fronted subscription hosts don't reject us as a bot
      const res = await electronNet.fetch(url, {
        headers: { 'User-Agent': ua, Accept: '*/*' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
      })
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).trim().slice(0, 120)
        lastError = new Error(`HTTP ${res.status}${body ? ` — ${body}` : ''}`)
        if (res.status === 403 || res.status === 406 || res.status === 429) continue
        throw lastError
      }
      const proxies = parseSubscriptionBody(await res.text())
      if (proxies.length === 0) {
        // e.g. an html error page served with 200 — try the next identity
        lastError = new Error('no nodes found in subscription')
        continue
      }
      return proxies
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }
  throw lastError ?? new Error('subscription fetch failed')
}

/** fetch every subscription (fallback to its cache), merge into one node list */
async function collectProxies(): Promise<ClashProxy[]> {
  const merged: ClashProxy[] = []
  let failures = 0
  for (const sub of config.subscriptions) {
    try {
      const nodes = await fetchSubscription(sub.url)
      sub.nodeCount = nodes.length
      sub.updatedAt = Date.now()
      config.subNodes[sub.id] = nodes
      merged.push(...nodes)
    } catch (err) {
      failures++
      console.error(
        `[proxy] subscription "${sub.name}" failed:`,
        err instanceof Error ? err.message : err
      )
      const cached = config.subNodes[sub.id]
      if (cached?.length) merged.push(...(cached as ClashProxy[]))
    }
  }
  if (merged.length === 0) {
    throw new Error(
      config.subscriptions.length === 0
        ? 'no subscription configured'
        : 'all subscriptions failed to fetch'
    )
  }
  if (failures > 0) console.warn(`[proxy] ${failures} subscription(s) served from cache`)
  await saveConfig()
  return uniqueNames(merged)
}

// ------------------------------------------------------------------- core

// TUN needs an elevated process. Instead of a broker service, a scheduled
// task registered once with UAC runs mihomo with the admin token; starting
// and ending your own task needs no further elevation.

const TASK_NAME = 'HalloweenTunCore'

function schtasks(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('schtasks', args, { windowsHide: true }, (err, stdout) =>
      err ? reject(new Error(String(stdout || err.message).trim())) : resolve(String(stdout))
    )
  })
}

async function taskExists(): Promise<boolean> {
  if (process.platform !== 'win32') return false
  try {
    await schtasks(['/Query', '/TN', TASK_NAME])
    return true
  } catch {
    return false
  }
}

/** one UAC prompt; registers the elevated on-demand task */
async function installTunTask(): Promise<void> {
  const create = [
    '/Create', '/TN', TASK_NAME,
    '/TR', `"${binaryPath()}" -d "${workRoot()}"`,
    '/SC', 'ONCE', '/ST', '00:00', '/RL', 'HIGHEST', '/IT', '/F',
  ]
  // schtasks itself must run elevated — launch it through a UAC-elevated PowerShell
  const ps = `Start-Process -FilePath schtasks -ArgumentList @(${create
    .map((a) => `'${a.replace(/'/g, "''")}'`)
    .join(',')}) -Verb RunAs -Wait -PassThru | ForEach-Object { exit $_.ExitCode }`
  await new Promise<void>((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true }, (err, _o, stderr) => {
      if (err) {
        // a declined UAC dialog surfaces here as a canceled Start-Process
        reject(new Error(String(stderr || err.message).trim() || 'elevation declined'))
      } else {
        resolve()
      }
    })
  })
  if (!(await taskExists())) throw new Error('task was not registered')
}

async function runTunTask(): Promise<void> {
  await schtasks(['/Run', '/TN', TASK_NAME])
}

async function endTunTask(): Promise<void> {
  try {
    await schtasks(['/End', '/TN', TASK_NAME])
  } catch {
    // task not running — nothing to end
  }
}

/** the task-launched core is not our child — poll the controller to notice deaths */
function startTunWatchdog(): void {
  stopTunWatchdog()
  let misses = 0
  tunWatchdog = setInterval(() => {
    void coreApi('/version')
      .then(() => {
        misses = 0
      })
      .catch(() => {
        misses++
        if (misses >= 3 && state.running) {
          state.running = false
          state.lastError = 'tun core stopped responding'
          stopTunWatchdog()
        }
      })
  }, 3000)
}

function stopTunWatchdog(): void {
  if (tunWatchdog) {
    clearInterval(tunWatchdog)
    tunWatchdog = null
  }
}

/** mihomo streams one {"up","down"} json object per second on /traffic —
 * forward each sample to the renderer for the live chart */
async function startTrafficSampler(): Promise<void> {
  stopTrafficSampler()
  const ac = new AbortController()
  trafficAbort = ac
  try {
    const res = await fetch(`http://127.0.0.1:${state.ctrlPort}/traffic`, {
      headers: { Authorization: `Bearer ${config.secret}` },
      signal: ac.signal,
    })
    if (!res.ok || !res.body) return
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done || ac.signal.aborted) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const s = line.trim()
        if (!s) continue
        try {
          const t = JSON.parse(s) as { up: number; down: number; upTotal?: number; downTotal?: number }
          getWin()?.webContents.send('proxy:traffic', {
            up: t.up ?? 0,
            down: t.down ?? 0,
            upTotal: t.upTotal ?? 0,
            downTotal: t.downTotal ?? 0,
            ts: Date.now(),
          })
        } catch {
          // partial line — wait for more bytes
        }
      }
    }
  } catch {
    // core stopped — the stream ends by itself
  }
}

function stopTrafficSampler(): void {
  trafficAbort?.abort()
  trafficAbort = null
}

function binaryPath(): string {
  const dev = path.join(__dirname, '../../resources/mihomo.exe')
  if (fs.existsSync(dev)) return dev
  const prod = path.join(process.resourcesPath ?? '', 'mihomo.exe')
  if (fs.existsSync(prod)) return prod
  throw new Error(
    'mihomo.exe not found — run "bun scripts/ensure-mihomo.mjs" in packages/desktop (see resources/README.md)'
  )
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

async function freePort(base: number): Promise<number> {
  for (let p = base; p < base + 20; p++) {
    if (await portFree(p)) return p
  }
  throw new Error(`no free port near ${base}`)
}

async function coreApi<T>(route: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${state.ctrlPort}${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.secret}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) throw new Error(`core api ${route}: HTTP ${res.status}`)
  // e.g. PUT switch answers 204 No Content — res.json() would throw on it
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

async function writeCoreConfig(proxies: ClashProxy[], tun: boolean): Promise<void> {
  const dir = workRoot()
  await fsp.mkdir(dir, { recursive: true })
  // no geo files on purpose — they would need a github download on first start,
  // which fails inside the wall; LAN/CN splits can come later with local geo dbs
  const doc: Record<string, unknown> = {
    'mixed-port': state.mixedPort,
    'external-controller': `127.0.0.1:${state.ctrlPort}`,
    secret: config.secret,
    'log-level': 'warning',
    mode: 'rule',
    proxies,
    'proxy-groups': [{ name: GROUP, type: 'select', proxies: proxies.map((p) => p.name) }],
    rules: [
      'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
      'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
      'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
      'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
      'IP-CIDR,169.254.0.0/16,DIRECT,no-resolve',
      `MATCH,${GROUP}`,
    ],
  }
  if (tun) {
    // fake-ip: clients get a synthetic IP, mihomo routes by domain —
    // poisoned domestic answers never matter for proxied traffic
    doc.tun = {
      enable: true,
      stack: 'mixed',
      'auto-route': true,
      'auto-detect-interface': true,
      'dns-hijack': ['any:53'],
    }
    doc.dns = {
      enable: true,
      'enhanced-mode': 'fake-ip',
      'fake-ip-range': '198.18.0.1/16',
      nameserver: ['223.5.5.5', '119.29.29.29'],
    }
  }
  await fsp.writeFile(path.join(dir, 'config.yaml'), stringifyYaml(doc), 'utf-8')
}

/** the task-launched core writes no piped stdout — its file log is the only failure evidence */
async function tailCoreLogFile(): Promise<string> {
  try {
    const dir = path.join(workRoot(), 'logs')
    const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.log'))
    if (files.length === 0) return ''
    const latest = files.sort().at(-1)!
    const text = await fsp.readFile(path.join(dir, latest), 'utf-8')
    return text.slice(-2000)
  } catch {
    return ''
  }
}

async function startCore(): Promise<void> {
  if (state.running || state.busy) return
  state.busy = true
  state.lastError = ''
  const tun = config.mode === 'tun'
  try {
    if (tun && !(await taskExists())) throw new Error('tun-not-installed')
    const proxies = await collectProxies()
    state.mixedPort = await freePort(7890)
    state.ctrlPort = await freePort(9090)
    await writeCoreConfig(proxies, tun)
    stopping = false
    coreLog = ''
    if (tun) {
      // a leftover instance may still hold the config dir / ports
      await endTunTask()
      await runTunTask()
    } else {
      core = spawn(binaryPath(), ['-d', workRoot()], { windowsHide: true })
      core.stdout?.on('data', (d) => {
        coreLog = (coreLog + String(d)).slice(-2000)
      })
      core.stderr?.on('data', (d) => {
        coreLog = (coreLog + String(d)).slice(-2000)
      })
      core.on('error', (err) => {
        // spawn failures (EACCES, file lock) surface as 'error', never 'exit';
        // without a listener EventEmitter rethrows and crashes the main process
        coreLog = (coreLog + `\n${err.message}`).slice(-2000)
        core = null
        if (!stopping && state.running) {
          state.running = false
          state.lastError = `core failed\n${coreLog}`
          void setSystemProxy(false).catch(() => {})
        }
      })
      core.on('exit', () => {
        core = null
        if (!stopping && state.running) {
          state.running = false
          state.lastError = `core exited unexpectedly\n${coreLog}`
          // never leave a dead proxy configured system-wide
          void setSystemProxy(false).catch(() => {})
        }
      })
    }
    // wait for the external controller to answer
    const deadline = Date.now() + CORE_START_TIMEOUT_MS
    for (;;) {
      try {
        await coreApi('/version')
        break
      } catch (err) {
        if (Date.now() > deadline || (!tun && core === null)) {
          if (tun) await endTunTask().catch(() => {})
          const tunLog = tun ? await tailCoreLogFile() : ''
          throw new Error(`core failed to start\n${coreLog || tunLog || String(err)}`)
        }
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    state.running = true
    if (tun) startTunWatchdog()
    void startTrafficSampler()
  } catch (err) {
    if (tun) await endTunTask().catch(() => {})
    killCore()
    state.running = false
    state.lastError = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    state.busy = false
  }
}

function killCore(): void {
  stopping = true
  core?.kill()
  core = null
}

async function stopCore(): Promise<void> {
  stopTunWatchdog()
  stopTrafficSampler()
  if (config.mode === 'tun') await endTunTask()
  killCore()
  state.running = false
}

// ------------------------------------------------------------ system proxy

const WININET_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
// keep local/LAN traffic out of the proxy (vite dev servers etc.)
const BYPASS =
  'localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>'
const PS_REFRESH =
  "$sig='[DllImport(\"wininet.dll\")]public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l);';" +
  '$t=Add-Type -MemberDefinition $sig -Name W -Namespace P -PassThru;' +
  '[void]$t::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0);' +
  '[void]$t::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)'

function runPsRefresh(): Promise<void> {
  // best effort — browsers re-read proxy settings on their own schedule;
  // a failed refresh must not fail the whole enable/disable
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', PS_REFRESH], { windowsHide: true }, (err) => {
      if (err) console.error('[proxy] wininet refresh failed:', err.message)
      resolve()
    })
  })
}

function reg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile('reg', args, (err) => (err ? reject(err) : resolve()))
  )
}

async function setSystemProxy(enable: boolean): Promise<void> {
  if (process.platform !== 'win32') {
    state.sysProxy = enable
    return
  }
  if (enable) {
    await reg([
      'add', WININET_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f',
    ])
    await reg([
      'add', WININET_KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d',
      `127.0.0.1:${state.mixedPort}`, '/f',
    ])
    await reg(['add', WININET_KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', BYPASS, '/f'])
  } else {
    // only clear what we set — another client (clash verge) may own the
    // system proxy right now and must not be switched off by us
    const current = await new Promise<string>((resolve) => {
      execFile(
        'reg',
        ['query', WININET_KEY, '/v', 'ProxyServer'],
        { windowsHide: true },
        (err, stdout) => {
          const m = stdout ? /ProxyServer\s+REG_SZ\s+(\S+)/.exec(String(stdout)) : null
          resolve(err || !m ? '' : m[1])
        }
      )
    })
    if (current && current !== `127.0.0.1:${state.mixedPort}`) {
      state.sysProxy = false
      return
    }
    await reg([
      'add', WININET_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f',
    ])
  }
  await runPsRefresh()
  state.sysProxy = enable
}

/** synchronous variant for app quit — must not leave the system pointing at a dead proxy */
export function shutdownProxy(): void {
  killCore()
  stopTunWatchdog()
  stopTrafficSampler()
  if (process.platform === 'win32') {
    if (config.mode === 'tun') {
      try {
        execFileSync('schtasks', ['/End', '/TN', TASK_NAME], { windowsHide: true })
      } catch {
        // task not running — fine
      }
    }
    if (state.sysProxy) {
      try {
        execFileSync('reg', [
          'add', WININET_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f',
        ])
        execFileSync('powershell', ['-NoProfile', '-Command', PS_REFRESH])
      } catch {
        // best effort
      }
      state.sysProxy = false
    }
  }
}

// -------------------------------------------------------------------- IPC

function publicState() {
  return {
    supported: SUPPORTED,
    running: state.running,
    busy: state.busy,
    sysProxy: state.sysProxy,
    mode: config.mode,
    tunReady: state.tunReady,
    mixedPort: state.mixedPort,
    subscriptions: config.subscriptions,
    nodeCount: cachedNodeCount(),
    /** node names from the last successful fetch — shown before the core runs */
    cachedNodes: uniqueNames(
      Object.values(config.subNodes).flat() as ClashProxy[]
    ).map((p) => p.name),
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
  getWin = getWindow
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
    if (!SUPPORTED) throw new Error('proxy is only supported on Windows')
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
    if (!SUPPORTED) throw new Error('proxy is only supported on Windows')
    if (mode !== 'sys' && mode !== 'tun') throw new Error('invalid mode')
    const wasRunning = state.running
    if (wasRunning) await proxyDisable()
    config.mode = mode
    await saveConfig()
    if (wasRunning) await proxyEnable()
    return publicState()
  })

  ipcMain.handle('proxy:install-tun', async () => {
    if (!SUPPORTED) throw new Error('proxy is only supported on Windows')
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
      `/group/${encodeURIComponent(GROUP)}/delay?url=${encodeURIComponent(DELAY_TEST_URL)}&timeout=5000`
    )
    return readNodes()
  })
}
