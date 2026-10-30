import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { logger } from 'hono/logger'
import { getCookie, setCookie } from 'hono/cookie'

const PORT = Number(process.env.PORT ?? 3690)
const DATA_ROOT = path.resolve(process.env.DATA_ROOT ?? './data')
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ?? ''
const TOKEN = process.env.TOKEN ?? ''
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? ''
const ADMIN_DIR = path.resolve(import.meta.dir, '../public/admin')

if (!TOKEN || !ADMIN_PASSWORD) {
  console.error('[server] env TOKEN and ADMIN_PASSWORD are required')
  process.exit(1)
}
await fs.mkdir(DATA_ROOT, { recursive: true })
console.log(`[server] data root: ${DATA_ROOT}`)

class HTTPError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** resolve a cloud-root-relative path, rejecting escapes like `..` */
function resolveSafe(rel: string): string {
  if (rel.includes('\0')) throw new HTTPError(400, 'invalid path')
  const p = path.resolve(DATA_ROOT, '.' + path.posix.normalize('/' + safeDecode(rel)))
  if (p !== DATA_ROOT && !p.startsWith(DATA_ROOT + path.sep)) {
    throw new HTTPError(400, 'invalid path')
  }
  return p
}

async function statEntry(parentAbs: string, name: string, relPath: string) {
  const s = await fs.stat(path.join(parentAbs, name)).catch(() => null)
  return {
    name,
    type: s?.isDirectory() ? ('dir' as const) : ('file' as const),
    size: s?.isFile() ? s.size : 0,
    mtime: s?.mtimeMs ?? 0,
    path: relPath,
  }
}

// ---------------------------------------------------------------- device tokens

interface DeviceToken {
  id: string
  token: string
  name: string
  createdAt: number
}

const TOKENS_FILE = path.join(DATA_ROOT, '.tokens.json')
let deviceTokens: DeviceToken[] = []

async function loadTokens(): Promise<void> {
  try {
    const raw = JSON.parse(await fs.readFile(TOKENS_FILE, 'utf-8')) as { tokens?: DeviceToken[] }
    deviceTokens = raw.tokens ?? []
  } catch {
    deviceTokens = []
  }
}
async function saveTokens(): Promise<void> {
  await fs.writeFile(TOKENS_FILE, JSON.stringify({ tokens: deviceTokens }, null, 2), 'utf-8')
}
await loadTokens()

function isKnownToken(candidate: string | undefined): boolean {
  return Boolean(candidate && (candidate === TOKEN || deviceTokens.some((d) => d.token === candidate)))
}

// ------------------------------------------------------------- device flow state

interface DeviceSession {
  userCode: string
  name: string
  status: 'pending' | 'approved' | 'denied'
  token?: string
  expiresAt: number
}

const DEVICE_TTL_MS = 10 * 60 * 1000
const deviceSessions = new Map<string, DeviceSession>()

function pruneDeviceSessions(): void {
  const now = Date.now()
  for (const [code, session] of deviceSessions) {
    if (session.expiresAt < now) deviceSessions.delete(code)
  }
}

// ------------------------------------------------------------------ admin session

const ADMIN_COOKIE = 'halloween_admin'
const ADMIN_TTL_MS = 12 * 60 * 60 * 1000

function adminSecret(): string {
  return createHmac('sha256', TOKEN).update(ADMIN_PASSWORD).digest('hex')
}

function issueAdminSession(): string {
  const expiry = Date.now() + ADMIN_TTL_MS
  const signature = createHmac('sha256', adminSecret()).update(String(expiry)).digest('hex')
  return `${expiry}.${signature}`
}

function isValidAdminSession(value: string | undefined): boolean {
  if (!value) return false
  const [expiryRaw, signature] = value.split('.')
  const expiry = Number(expiryRaw)
  if (!expiry || !signature || expiry < Date.now()) return false
  const expected = createHmac('sha256', adminSecret()).update(String(expiry)).digest('hex')
  return signature === expected
}

// ----------------------------------------------------------------------- apps

const cloud = new Hono()
const admin = new Hono()
const root = new Hono()

root.use(logger())

root.onError((err, c) => {
  if (err instanceof HTTPError) {
    return c.json({ error: err.message }, err.status as ContentfulStatusCode)
  }
  console.error(err)
  return c.json({ error: 'internal error' }, 500)
})

// bearer token (master or device), cookie, or ?token= (for media tags)
async function cloudAuth(c: Context, next: Next) {
  const header = c.req.header('Authorization')
  const candidate =
    header?.startsWith('Bearer ')
      ? header.slice(7)
      : (getCookie(c, 'halloween_token') ?? c.req.query('token'))
  if (!isKnownToken(candidate)) return c.json({ error: 'unauthorized' }, 401)
  await next()
}

async function adminAuth(c: Context, next: Next) {
  const header = c.req.header('Authorization')
  if (header === `Bearer ${TOKEN}`) return next()
  if (isValidAdminSession(getCookie(c, ADMIN_COOKIE))) return next()
  return c.json({ error: 'unauthorized' }, 401)
}

// ------------------------------------------------------------------ cloud: auth

cloud.get('/api/health', (c) => c.json({ ok: true }))

// endpoints reachable before any token exists: health + device authorization flow
const CLOUD_PUBLIC_PATHS = new Set([
  '/cloud/api/health',
  '/cloud/api/device/code',
  '/cloud/api/device/token',
])
cloud.use('/api/*', async (c, next) => {
  if (CLOUD_PUBLIC_PATHS.has(c.req.path)) return next()
  return cloudAuth(c, next)
})
cloud.use('/f/*', cloudAuth)

// device authorization flow (no auth required)
cloud.post('/api/device/code', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  pruneDeviceSessions()
  const deviceCode = randomUUID()
  const userCode = String(100000 + Math.floor(Math.random() * 900000))
  deviceSessions.set(deviceCode, {
    userCode,
    name: String((body as { name?: string }).name ?? 'Unknown device').slice(0, 64),
    status: 'pending',
    expiresAt: Date.now() + DEVICE_TTL_MS,
  })
  const origin = PUBLIC_ORIGIN || new URL(c.req.url).origin
  return c.json({
    device_code: deviceCode,
    user_code: userCode,
    verify_url: `${origin}/admin/#/device/${userCode}`,
    expires_in: DEVICE_TTL_MS / 1000,
  })
})

cloud.post('/api/device/token', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const deviceCode = (body as { device_code?: string }).device_code ?? ''
  const session = deviceSessions.get(deviceCode)
  if (!session) return c.json({ error: 'invalid device code' }, 400)
  if (session.expiresAt < Date.now()) {
    deviceSessions.delete(deviceCode)
    return c.json({ status: 'expired' }, 410)
  }
  if (session.status === 'pending') return c.json({ status: 'pending' })
  if (session.status === 'denied') return c.json({ status: 'denied' }, 403)
  const token = session.token!
  deviceSessions.delete(deviceCode)
  return c.json({ status: 'approved', token })
})

// ------------------------------------------------------------------ cloud: files

cloud.get('/api/files', async (c) => {
  const dir = resolveSafe(c.req.query('path') ?? '/')
  const st = await fs.stat(dir).catch(() => null)
  if (!st) throw new HTTPError(404, 'not found')
  if (!st.isDirectory()) throw new HTTPError(400, 'not a directory')
  const rel = safeDecode(c.req.query('path') ?? '/')
  const dirents = await fs.readdir(dir, { withFileTypes: true })
  const entries = await Promise.all(
    dirents.filter((d) => !d.name.startsWith('.')).map((d) => statEntry(dir, d.name, path.posix.join(rel, d.name)))
  )
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
  )
  return c.json({ entries })
})

cloud.post('/api/upload', async (c) => {
  const dir = resolveSafe(c.req.query('path') ?? '/')
  const name = path.basename(safeDecode(c.req.query('name') ?? ''))
  if (!name || name === '.' || name === '..') throw new HTTPError(400, 'invalid name')
  const body = c.req.raw.body
  if (!body) throw new HTTPError(400, 'empty body')
  const target = path.join(dir, name)
  await Bun.write(target, body)
  const st = await fs.stat(target)
  return c.json({ ok: true, name, size: st.size })
})

cloud.post('/api/mkdir', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const dir = resolveSafe((body as { path?: string }).path ?? '')
  if (dir === DATA_ROOT) throw new HTTPError(400, 'invalid path')
  await fs.mkdir(dir, { recursive: true })
  return c.json({ ok: true })
})

cloud.post('/api/rename', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { from, to } = body as { from?: string; to?: string }
  const fromAbs = resolveSafe(from ?? '')
  const toAbs = resolveSafe(to ?? '')
  if (fromAbs === DATA_ROOT || toAbs === DATA_ROOT) throw new HTTPError(400, 'invalid path')
  if (fss.existsSync(toAbs)) throw new HTTPError(409, 'target exists')
  await fs.rename(fromAbs, toAbs).catch((err: NodeJS.ErrnoException) => {
    throw new HTTPError(err.code === 'ENOENT' ? 404 : 500, err.code ?? 'rename failed')
  })
  return c.json({ ok: true })
})

cloud.post('/api/delete', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const paths = (body as { paths?: string[] }).paths ?? []
  for (const rel of paths) {
    const abs = resolveSafe(rel)
    if (abs === DATA_ROOT) continue
    await fs.rm(abs, { recursive: true, force: true })
  }
  return c.json({ ok: true, deleted: paths.length })
})

cloud.get('/api/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim().toLowerCase()
  if (!q) return c.json({ entries: [] })
  const results: Awaited<ReturnType<typeof statEntry>>[] = []
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (results.length >= 500 || depth > 8) return
    const abs = resolveSafe(rel)
    const dirents = await fs.readdir(abs, { withFileTypes: true }).catch(() => [])
    for (const d of dirents) {
      if (d.name.startsWith('.')) continue
      const childRel = rel === '/' ? `/${d.name}` : `${rel}/${d.name}`
      if (d.name.toLowerCase().includes(q)) {
        results.push(await statEntry(abs, d.name, childRel))
      }
      if (d.isDirectory()) await walk(childRel, depth + 1)
      if (results.length >= 500) return
    }
  }
  await walk('/', 0)
  return c.json({ entries: results })
})

cloud.get('/api/check', (c) => c.json({ ok: true }))

// raw file stream; in production nginx takes /cloud/f/ over (alias + auth_request)
cloud.get('/f/*', async (c) => {
  const marker = c.req.path.indexOf('/f/')
  const rel = safeDecode(c.req.path.slice(marker + '/f/'.length))
  const file = resolveSafe(rel)
  const st = await fs.stat(file).catch(() => null)
  if (!st?.isFile()) throw new HTTPError(404, 'not found')
  const f = Bun.file(file)
  return new Response(f, {
    headers: {
      'Content-Type': f.type || 'application/octet-stream',
      'Content-Length': String(st.size),
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
    },
  })
})

// ----------------------------------------------------------------- admin: api

admin.post('/api/login', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const password = (body as { password?: string }).password ?? ''
  if (password !== ADMIN_PASSWORD) return c.json({ error: 'wrong password' }, 401)
  setCookie(c, ADMIN_COOKIE, issueAdminSession(), {
    path: '/',
    sameSite: 'Lax',
    httpOnly: true,
    maxAge: ADMIN_TTL_MS / 1000,
  })
  return c.json({ ok: true })
})

admin.post('/api/logout', (c) => {
  setCookie(c, ADMIN_COOKIE, '', { path: '/', maxAge: 0 })
  return c.json({ ok: true })
})

admin.get('/api/session', (c) => c.json({ ok: true }))

admin.use('/api/*', async (c, next) => {
  if (c.req.path.startsWith('/admin/api/login')) return next()
  return adminAuth(c, next)
})

admin.get('/api/stats', async (c) => {
  const statfs = await fs.statfs(DATA_ROOT).catch(() => null)
  const total = statfs ? Number(statfs.blocks) * Number(statfs.bsize) : 0
  const available = statfs ? Number(statfs.bavail) * Number(statfs.bsize) : 0
  return c.json({
    storage: { total, available, used: Math.max(total - available, 0) },
    devices: deviceTokens.length,
  })
})

admin.get('/api/devices', (c) =>
  c.json({
    devices: deviceTokens.map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt })),
  })
)

admin.post('/api/devices/revoke', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const id = (body as { id?: string }).id ?? ''
  deviceTokens = deviceTokens.filter((d) => d.id !== id)
  await saveTokens()
  return c.json({ ok: true })
})

admin.post('/api/device/approve', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const userCode = (body as { user_code?: string }).user_code ?? ''
  pruneDeviceSessions()
  for (const session of deviceSessions.values()) {
    if (session.userCode === userCode) {
      if (session.status !== 'pending') return c.json({ error: 'already handled' }, 409)
      const token = randomBytes(24).toString('hex')
      const device: DeviceToken = {
        id: randomUUID(),
        token,
        name: session.name,
        createdAt: Date.now(),
      }
      deviceTokens.push(device)
      await saveTokens()
      session.status = 'approved'
      session.token = token
      return c.json({ ok: true })
    }
  }
  return c.json({ error: 'unknown code' }, 404)
})

// ----------------------------------------------------------------- admin: static

admin.get('*', async (c) => {
  const rel = safeDecode(c.req.path.replace(/^\/admin\/?/, ''))
  const candidate = path.resolve(ADMIN_DIR, rel || 'index.html')
  let file = candidate
  if (!file.startsWith(ADMIN_DIR) || !fss.existsSync(file) || fss.statSync(file).isDirectory()) {
    file = path.join(ADMIN_DIR, 'index.html') // SPA fallback
  }
  if (!fss.existsSync(file)) return c.text('admin bundle missing — run admin build', 404)
  return new Response(Bun.file(file))
})

root.route('/cloud', cloud)
root.route('/admin', admin)

export default {
  port: PORT,
  fetch: root.fetch,
}
