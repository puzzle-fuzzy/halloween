import { spawn, execFileSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import type { ClashProxy } from '../proxy-parse'
import { binaryPath, config, workRoot } from './config'
import { collectProxies } from './subscription'
import { endTunTask, runTunTask, taskExists, TASK_NAME } from './tun'
import { setSystemProxy, WININET_KEY, PS_REFRESH } from './sysproxy'
import { startTrafficSampler, stopTrafficSampler } from './traffic'
import { state } from './state'

/** proxy group name everything is routed through */
export const GROUP = '🚀 Node'
const CORE_START_TIMEOUT_MS = 10_000

let core: ReturnType<typeof spawn> | null = null
let coreLog = ''
let stopping = false
let tunWatchdog: ReturnType<typeof setInterval> | null = null

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

export async function coreApi<T>(route: string, init?: RequestInit): Promise<T> {
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

export async function startCore(): Promise<void> {
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

export async function stopCore(): Promise<void> {
  stopTunWatchdog()
  stopTrafficSampler()
  if (config.mode === 'tun') await endTunTask()
  killCore()
  state.running = false
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
