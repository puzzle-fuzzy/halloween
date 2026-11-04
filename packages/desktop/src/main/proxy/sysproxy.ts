import { execFile } from 'node:child_process'
import { state } from './state'

const WININET_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
// keep local/LAN traffic out of the proxy (vite dev servers etc.)
const BYPASS =
  'localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>'
const PS_REFRESH =
  '$sig=\'[DllImport("wininet.dll")]public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l);\';' +
  '$t=Add-Type -MemberDefinition $sig -Name W -Namespace P -PassThru;' +
  '[void]$t::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0);' +
  '[void]$t::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)'

export { PS_REFRESH, WININET_KEY }

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
    execFile('reg', args, (err) => (err ? reject(err) : resolve())),
  )
}

/** macOS: proxies live per network service; apply to every enabled one */
const MAC_BYPASS = [
  'localhost',
  '127.0.0.1',
  '10.*',
  '172.16.*',
  '172.17.*',
  '172.18.*',
  '172.19.*',
  '172.20.*',
  '172.21.*',
  '172.22.*',
  '172.23.*',
  '172.24.*',
  '172.25.*',
  '172.26.*',
  '172.27.*',
  '172.28.*',
  '172.29.*',
  '172.30.*',
  '172.31.*',
  '192.168.*',
  '*.local',
]

function networksetup(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('networksetup', args, (err, stdout) =>
      err ? reject(new Error(String(stdout || err.message).trim())) : resolve(String(stdout)),
    )
  })
}

async function macNetworkServices(): Promise<string[]> {
  const out = await networksetup(['-listallnetworkservices'])
  // first line is a header; disabled services are prefixed with an asterisk
  return out
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('*'))
}

async function setSystemProxyMac(enable: boolean): Promise<void> {
  const services = await macNetworkServices()
  for (const service of services) {
    try {
      if (enable) {
        await networksetup(['-setwebproxy', service, '127.0.0.1', String(state.mixedPort)])
        await networksetup(['-setsecurewebproxy', service, '127.0.0.1', String(state.mixedPort)])
        await networksetup(['-setproxybypassdomains', service, ...MAC_BYPASS])
      } else {
        // ownership check per service — never switch off someone else's proxy
        for (const kind of ['-getwebproxy', '-getsecurewebproxy']) {
          const info = await networksetup([kind, service])
          const server = /ProxyServer:\s*([^\s]+)/.exec(info)?.[1] ?? ''
          if (!server || server === `127.0.0.1:${state.mixedPort}`) {
            await networksetup([
              kind === '-getwebproxy' ? '-setwebproxystate' : '-setsecurewebproxystate',
              service,
              'off',
            ])
          }
        }
      }
    } catch (err) {
      console.error(
        `[proxy] networksetup ${service} failed:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
  state.sysProxy = enable
}

export async function setSystemProxy(enable: boolean): Promise<void> {
  if (process.platform === 'darwin') {
    await setSystemProxyMac(enable)
    return
  }
  if (process.platform !== 'win32') {
    state.sysProxy = enable
    return
  }
  if (enable) {
    await reg(['add', WININET_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f'])
    await reg([
      'add',
      WININET_KEY,
      '/v',
      'ProxyServer',
      '/t',
      'REG_SZ',
      '/d',
      `127.0.0.1:${state.mixedPort}`,
      '/f',
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
        },
      )
    })
    if (current && current !== `127.0.0.1:${state.mixedPort}`) {
      state.sysProxy = false
      return
    }
    await reg(['add', WININET_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f'])
  }
  await runPsRefresh()
  state.sysProxy = enable
}
