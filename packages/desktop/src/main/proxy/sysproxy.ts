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

export async function setSystemProxy(enable: boolean): Promise<void> {
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
