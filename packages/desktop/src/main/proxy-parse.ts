import { parse as parseYaml } from 'yaml'

/** a raw clash-format proxy object as mihomo consumes it */
export type ClashProxy = Record<string, unknown> & { name: string }

function b64Decode(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  return Buffer.from(padded, 'base64').toString('utf-8')
}

/** ss://BASE64(method:pass)@host:port#name and the legacy all-base64 variant */
function parseSS(uri: string): ClashProxy | null {
  const body = uri.slice('ss://'.length)
  const [main, frag] = splitFragment(body)
  let method = ''
  let password = ''
  let hostPort = ''
  const at = main.lastIndexOf('@')
  if (at >= 0) {
    const userinfo = main.slice(0, at)
    hostPort = main.slice(at + 1)
    if (userinfo.includes(':')) {
      ;[method, password] = userinfo.split(':')
    } else {
      const decoded = b64Decode(userinfo)
      const sep = decoded.indexOf(':')
      if (sep < 0) return null
      method = decoded.slice(0, sep)
      password = decoded.slice(sep + 1)
    }
  } else {
    const decoded = b64Decode(main)
    const at2 = decoded.lastIndexOf('@')
    if (at2 < 0) return null
    const sep = decoded.indexOf(':')
    if (sep < 0 || sep > at2) return null
    method = decoded.slice(0, sep)
    password = decoded.slice(sep + 1, at2)
    hostPort = decoded.slice(at2 + 1)
  }
  const [host, port] = splitHostPort(hostPort)
  if (!host || !port || !method) return null
  return {
    name: frag || `${host}:${port}`,
    type: 'ss',
    server: host,
    port,
    cipher: method,
    password: decodeURIComponent(password),
  }
}

/** vmess://BASE64({v,ps,add,port,id,aid,net,host,tls,path,sni}) */
function parseVmess(uri: string): ClashProxy | null {
  let json: Record<string, unknown>
  try {
    json = JSON.parse(b64Decode(uri.slice('vmess://'.length)))
  } catch {
    return null
  }
  const host = String(json.add ?? '')
  const port = Number(json.port ?? 0)
  if (!host || !port) return null
  const proxy: ClashProxy = {
    name: String(json.ps ?? '') || `${host}:${port}`,
    type: 'vmess',
    server: host,
    port,
    uuid: String(json.id ?? ''),
    alterId: Number(json.aid ?? json.alterId ?? 0),
    cipher: 'auto',
    udp: true,
  }
  if (json.net === 'ws') {
    proxy.network = 'ws'
    proxy['ws-opts'] = {
      path: String(json.path ?? '/'),
      ...(json.host ? { headers: { Host: String(json.host) } } : {}),
    }
  }
  if (json.tls === 'tls' || json.tls === true) {
    proxy.tls = true
    proxy.servername = String(json.sni ?? json.host ?? '')
  }
  return proxy
}

/** trojan://password@host:port?sni=…#name */
function parseTrojan(uri: string): ClashProxy | null {
  let u: URL
  try {
    u = new URL(uri)
  } catch {
    return null
  }
  const host = u.hostname
  const port = Number(u.port || 443)
  const password = decodeURIComponent(u.username)
  if (!host || !password) return null
  const rawName = u.hash.slice(1)
  let name = rawName
  try {
    name = decodeURIComponent(rawName)
  } catch {
    // keep raw if it is not valid percent-encoding
  }
  return {
    name: name || `${host}:${port}`,
    type: 'trojan',
    server: host,
    port,
    password,
    sni: u.searchParams.get('sni') || host,
    'skip-cert-verify': u.searchParams.get('allowInsecure') === '1',
    udp: true,
  }
}

function splitFragment(body: string): [string, string] {
  const hash = body.indexOf('#')
  const main = hash >= 0 ? body.slice(0, hash) : body
  const frag = hash >= 0 ? decodeURIComponent(body.slice(hash + 1)) : ''
  return [main, frag]
}

function splitHostPort(value: string): [string, number] {
  const colon = value.lastIndexOf(':')
  if (colon < 0) return ['', 0]
  return [value.slice(0, colon), Number(value.slice(colon + 1))]
}

/** accepts a full clash config (proxies:) or a base64 node-link list */
export function parseSubscriptionBody(text: string): ClashProxy[] {
  const trimmed = text.trim()
  try {
    const doc = parseYaml(trimmed) as { proxies?: unknown[] } | null
    if (doc && Array.isArray(doc.proxies) && doc.proxies.length > 0) {
      return doc.proxies.filter((p): p is ClashProxy => Boolean((p as ClashProxy)?.name))
    }
  } catch {
    // not yaml — try node links below
  }
  const decoded = !trimmed.includes('://') ? b64Decode(trimmed) : trimmed
  const proxies: ClashProxy[] = []
  for (const line of decoded.split(/\r?\n/)) {
    const s = line.trim()
    let proxy: ClashProxy | null = null
    if (s.startsWith('ss://')) proxy = parseSS(s)
    else if (s.startsWith('vmess://')) proxy = parseVmess(s)
    else if (s.startsWith('trojan://')) proxy = parseTrojan(s)
    if (proxy) proxies.push(proxy)
  }
  return proxies
}

/** dedupe node names — mihomo refuses configs with duplicate proxy names */
export function uniqueNames(proxies: ClashProxy[]): ClashProxy[] {
  const seen = new Map<string, number>()
  return proxies.map((p) => {
    const count = seen.get(p.name) ?? 0
    seen.set(p.name, count + 1)
    return count === 0 ? p : { ...p, name: `${p.name} (${count + 1})` }
  })
}
