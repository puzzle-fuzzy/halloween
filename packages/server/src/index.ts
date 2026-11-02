import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { getCookie, setCookie } from 'hono/cookie'
import { bodyLimit } from 'hono/body-limit'
import { createOssService } from './oss'
import type { OssClientFactory } from './oss'
import { CloudFiles, relativePath } from './files'
import { atomicJson, HTTPError, initializeRoots, migrateState } from './storage'
import { jsonBody } from './http'
import { backupConfigFromEnv, createBackupManager } from './backups'
import type { BackupConfig, ResticRunner } from './backups'
import type { BackupJobKind } from '@halloween/contracts'

interface DeviceToken { id: string; tokenHash: string; name: string; createdAt: number }
interface UserProfile { name: string; email: string; avatar: string }
interface DeviceSession { userCode: string; name: string; status: 'pending' | 'approved' | 'denied'; token?: string; expiresAt: number }
export interface ApplicationOptions {
  dataRoot: string; stateRoot: string; token: string; adminPassword: string
  publicOrigin?: string; secureCookies?: boolean; trustProxy?: boolean; adminDir?: string
  maxUploadBytes?: number; now?: () => number; userCode?: () => string; ossClientFactory?: OssClientFactory; quiet?: boolean
  backupConfig?: BackupConfig; backupRunner?: ResticRunner
}
const ADMIN_COOKIE = 'halloween_admin'
const ADMIN_TTL = 12 * 60 * 60 * 1000
const DEVICE_TTL = 10 * 60 * 1000
const PREVIEW_TTL = 5 * 60 * 1000
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function equal(a: string, b: string): boolean { return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b))) }
function parseTokens(raw: unknown): { tokens: DeviceToken[] } {
  const rows = (raw as { tokens?: unknown })?.tokens
  if (!Array.isArray(rows)) throw new Error('invalid device tokens')
  const tokens = rows.map((row) => {
    if (!row || typeof row.id !== 'string' || typeof row.name !== 'string' || !Number.isFinite(row.createdAt)) throw new Error('invalid device token')
    const tokenHash = row.tokenHash ?? (typeof row.token === 'string' && row.token ? hash(row.token) : '')
    if (typeof tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(tokenHash)) throw new Error('invalid token hash')
    return { id: row.id, tokenHash, name: row.name, createdAt: row.createdAt }
  })
  if (new Set(tokens.map((t) => t.id)).size !== tokens.length) throw new Error('duplicate device token IDs')
  return { tokens }
}
function parseProfile(raw: unknown): UserProfile {
  const profile = raw as UserProfile
  if (!profile || ['name', 'email', 'avatar'].some((key) => typeof profile[key as keyof UserProfile] !== 'string')) throw new Error('invalid profile')
  return { name: profile.name, email: profile.email, avatar: profile.avatar }
}
class RateLimiter {
  private entries = new Map<string, { count: number; until: number }>()
  constructor(private now: () => number) {}
  allow(key: string, limit: number, window: number): boolean {
    const now = this.now()
    for (const [k, value] of this.entries) if (value.until <= now) this.entries.delete(k)
    let entry = this.entries.get(key)
    if (!entry) { entry = { count: 0, until: now + window }; this.entries.set(key, entry) }
    return ++entry.count <= limit
  }
}
function rawFilePath(uri: string): string | undefined {
  const pathname = uri.split('?')[0]!
  if (!pathname.startsWith('/cloud/f/')) return undefined
  try { return relativePath(decodeURIComponent(pathname.slice('/cloud/f/'.length))) }
  catch { return undefined }
}

export async function createApplication(options: ApplicationOptions): Promise<Hono> {
  if (options.token.length < 32 || options.adminPassword.length < 12) throw new Error('TOKEN must be at least 32 characters and ADMIN_PASSWORD at least 12 characters')
  const roots = await initializeRoots(path.resolve(options.dataRoot), path.resolve(options.stateRoot))
  const { dataRoot, stateRoot } = roots
  const maxUploadBytes = options.maxUploadBytes ?? 100 * 1024 ** 3
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0) throw new Error('MAX_UPLOAD_BYTES must be a positive safe integer')
  const files = new CloudFiles(dataRoot, stateRoot, maxUploadBytes)
  const now = options.now ?? Date.now
  const limiter = new RateLimiter(now)
  const mutate = <T>(work: () => Promise<T>) => files.withSnapshot(work)
  let { tokens } = await migrateState(dataRoot, stateRoot, '.tokens.json', 'tokens.json', parseTokens, { tokens: [] })
  // Normalize old plaintext tokens even when an earlier state directory already contains them.
  await atomicJson(path.join(stateRoot, 'tokens.json'), { tokens })
  let profile = await migrateState(dataRoot, stateRoot, '.profile.json', 'profile.json', parseProfile, { name: '', email: '', avatar: '' })
  const sessions = new Map<string, DeviceSession>()
  const adminSessions = new Map<string, number>()
  const publicOrigin = options.publicOrigin?.replace(/\/$/, '') ?? ''
  if (publicOrigin && !/^https?:\/\/[^/]+$/.test(publicOrigin)) throw new Error('PUBLIC_ORIGIN must be an http(s) origin without a path')
  const secret = createHmac('sha256', options.token).update(options.adminPassword).digest()
  const sign = (value: string) => createHmac('sha256', secret).update(value).digest('base64url')
  function knownToken(candidate: string | undefined): boolean {
    return Boolean(candidate && (equal(candidate, options.token) || tokens.some((t) => equal(hash(candidate), t.tokenHash))))
  }
  function validAdmin(value: string | undefined): boolean {
    if (!value) return false
    const [expiryRaw, nonce, signature] = value.split('.')
    const expiry = Number(expiryRaw)
    if (!nonce || !signature || !Number.isSafeInteger(expiry) || expiry <= now() || expiry > now() + ADMIN_TTL) return false
    return adminSessions.get(nonce) === expiry && equal(signature, sign(`admin:${expiry}.${nonce}`))
  }
  function issueAdmin() {
    for (const [key, expiry] of adminSessions) if (expiry <= now()) adminSessions.delete(key)
    const expiry = now() + ADMIN_TTL, nonce = randomBytes(24).toString('base64url')
    adminSessions.set(nonce, expiry)
    return `${expiry}.${nonce}.${sign(`admin:${expiry}.${nonce}`)}`
  }
  function previewValid(ticket: string | undefined, expectedPath: string | undefined): boolean {
    if (!ticket || !expectedPath) return false
    const [payload, signature] = ticket.split('.')
    if (!payload || !signature || !equal(signature, sign(`preview:${payload}`))) return false
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { p: string; e: number }
      return claims.p === expectedPath && Number.isSafeInteger(claims.e) && claims.e > now() && claims.e <= now() + PREVIEW_TTL
    } catch { return false }
  }
  function origin(c: Context): string {
    if (publicOrigin) return publicOrigin
    const url = new URL(c.req.url)
    if (options.trustProxy && c.req.header('X-Forwarded-Proto') === 'https') url.protocol = 'https:'
    return url.origin
  }
  function ip(c: Context): string { return (options.trustProxy ? c.req.header('X-Real-IP') : undefined) ?? c.env?.clientIp ?? 'local' }
  function rate(c: Context, category: string, limit: number, window = 60_000): boolean {
    if (limiter.allow(`${category}:${ip(c)}`, limit, window)) return true
    c.header('Retry-After', String(Math.ceil(window / 1000)))
    return false
  }
  async function cloudAuth(c: Context, next: Next) {
    const header = c.req.header('Authorization')
    const candidate = header?.startsWith('Bearer ') ? header.slice(7) : undefined
    if (knownToken(candidate)) return next()
    const isFile = c.req.path.startsWith('/cloud/f/'), isCheck = c.req.path === '/cloud/api/check'
    if (isFile || isCheck) {
      const original = isCheck ? c.req.header('X-Original-URI') ?? '' : c.req.url.slice(new URL(c.req.url).origin.length)
      // nginx forwards the original URI explicitly; subrequests do not inherit query arguments.
      const originalUrl = new URL(original || '/', 'http://internal')
      const expected = rawFilePath(originalUrl.pathname)
      if (previewValid(originalUrl.searchParams.get('ticket') ?? undefined, expected)) return next()
      // Existing clients keep working; new clients use short-lived, file-scoped tickets.
      if (knownToken(originalUrl.searchParams.get('token') ?? undefined)) return next()
    }
    return c.json({ error: 'unauthorized' }, 401)
  }
  async function adminAuth(c: Context, next: Next) {
    const header = c.req.header('Authorization')
    if (header?.startsWith('Bearer ') && equal(header.slice(7), options.token)) return next()
    if (!validAdmin(getCookie(c, ADMIN_COOKIE))) return c.json({ error: 'unauthorized' }, 401)
    const requestOrigin = c.req.header('Origin')
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && requestOrigin && requestOrigin !== origin(c)) return c.json({ error: 'invalid origin' }, 403)
    return next()
  }
  function findSession(userCode: string): DeviceSession {
    for (const [key, session] of sessions) if (session.userCode === userCode) {
      if (session.expiresAt <= now()) { sessions.delete(key); throw new HTTPError(410, 'device code expired') }
      return session
    }
    throw new HTTPError(404, 'unknown code')
  }
  const root = new Hono(), cloud = new Hono(), admin = new Hono()
  root.use(async (c, next) => {
    await next()
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'no-referrer')
    if (c.req.path.includes('/api/')) c.header('Cache-Control', 'no-store')
    if (!options.quiet) console.log(`[server] ${c.req.method} ${c.req.path} ${c.res.status}`)
  })
  root.use('/cloud/api/*', (c, next) => c.req.path === '/cloud/api/upload' ? next() : bodyLimit({ maxSize: c.req.path.includes('/device/') ? 4096 : 1024 * 1024, onError: (ctx) => ctx.json({ error: 'JSON body too large' }, 413) })(c, next))
  root.use('/admin/api/*', bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'JSON body too large' }, 413) }))
  root.use('/oss/api/*', bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'JSON body too large' }, 413) }))
  root.onError((error, c) => {
    if (error instanceof HTTPError) return c.json({ error: error.message }, error.status as ContentfulStatusCode)
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return c.json({ error: 'not found' }, 404)
    if (code === 'ENOSPC' || code === 'EDQUOT') return c.json({ error: 'storage full' }, 507)
    if (!options.quiet) console.error('[server]', error.name, code ?? '')
    return c.json({ error: 'internal error' }, 500)
  })
  const publicPaths = new Set(['/cloud/api/health', '/cloud/api/device/code', '/cloud/api/device/token'])
  cloud.use('/api/*', (c, next) => publicPaths.has(c.req.path) ? next() : cloudAuth(c, next))
  cloud.use('/f/*', cloudAuth)
  cloud.get('/api/health', (c) => c.json({ ok: true }))
  cloud.post('/api/device/code', async (c) => {
    if (!rate(c, 'device-code', 10)) return c.json({ error: 'too many device requests' }, 429)
    for (const [key, session] of sessions) if (session.expiresAt <= now()) sessions.delete(key)
    if (sessions.size >= 1000) throw new HTTPError(429, 'too many pending devices')
    const body = await jsonBody(c)
    let userCode = ''
    for (let i = 0; i < 100; i++) {
      const candidate = options.userCode?.() ?? String(randomInt(100000, 1000000))
      if (/^[0-9]{6}$/.test(candidate) && ![...sessions.values()].some((session) => session.userCode === candidate)) { userCode = candidate; break }
    }
    if (!userCode) throw new HTTPError(503, 'device code allocation unavailable')
    const deviceCode = randomBytes(32).toString('base64url')
    sessions.set(deviceCode, { userCode, name: String(body.name ?? 'Unknown device').slice(0, 64), status: 'pending', expiresAt: now() + DEVICE_TTL })
    return c.json({ device_code: deviceCode, user_code: userCode, verify_url: `${origin(c)}/admin/#/device/${userCode}`, expires_in: DEVICE_TTL / 1000 })
  })
  cloud.post('/api/device/token', async (c) => {
    if (!rate(c, 'device-poll', 120)) return c.json({ error: 'slow down' }, 429)
    const body = await jsonBody(c), key = String(body.device_code ?? ''), session = sessions.get(key)
    if (!session) throw new HTTPError(400, 'invalid device code')
    if (session.expiresAt <= now()) { sessions.delete(key); return c.json({ status: 'expired' }, 410) }
    if (session.status === 'denied') return c.json({ status: 'denied' }, 403)
    if (session.status === 'pending') return c.json({ status: 'pending' })
    sessions.delete(key)
    return c.json({ status: 'approved', token: session.token })
  })
  cloud.get('/api/files', async (c) => c.json({ entries: await files.list(c.req.query('path') ?? '/') }))
  cloud.post('/api/upload', async (c) => c.json(await files.upload(c.req.query('path') ?? '/', c.req.query('name') ?? '', c.req.raw.body)))
  cloud.post('/api/mkdir', async (c) => { const body = await jsonBody(c); await files.mkdir(body.path); return c.json({ ok: true }) })
  cloud.post('/api/rename', async (c) => { const body = await jsonBody(c); await files.rename(body.from, body.to); return c.json({ ok: true }) })
  cloud.post('/api/delete', async (c) => { const body = await jsonBody(c); return c.json({ ok: true, ...await files.trash(body.paths) }) })
  cloud.get('/api/trash', async (c) => c.json(await files.listTrash()))
  cloud.post('/api/trash/restore', async (c) => {
    const body = await jsonBody(c)
    if (typeof body.id !== 'string' || (body.destination !== undefined && typeof body.destination !== 'string')) throw new HTTPError(400, 'invalid restore request')
    return c.json(await files.restoreTrash(body.id, body.destination))
  })
  cloud.post('/api/trash/purge', async (c) => {
    const body = await jsonBody(c)
    if ((body.ids !== undefined && (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string'))) ||
      (body.all !== undefined && typeof body.all !== 'boolean') || typeof body.confirmation !== 'string') throw new HTTPError(400, 'invalid purge request')
    const result = await files.purgeTrash({ ids: body.ids as string[] | undefined, all: body.all as boolean | undefined, confirmation: body.confirmation })
    return c.json(result, result.ok ? 200 : 207)
  })
  cloud.get('/api/search', async (c) => c.json({ entries: await files.search(c.req.query('q') ?? '') }))
  cloud.get('/api/check', (c) => c.json({ ok: true }))
  cloud.get('/api/profile', (c) => c.json({ profile }))
  cloud.post('/api/preview-ticket', async (c) => {
    const body = await jsonBody(c), rel = relativePath(body.path), file = await files.resolve(rel)
    if (!(await fs.lstat(file)).isFile()) throw new HTTPError(400, 'not a file')
    const expiresAt = now() + PREVIEW_TTL, payload = Buffer.from(JSON.stringify({ p: rel, e: expiresAt })).toString('base64url')
    const ticket = `${payload}.${sign(`preview:${payload}`)}`
    return c.json({ url: `${origin(c)}/cloud/f/${rel.slice(1).split('/').map(encodeURIComponent).join('/')}?ticket=${ticket}`, expiresAt })
  })
  cloud.on(['GET', 'HEAD'], '/f/*', async (c) => {
    const rel = rawFilePath(c.req.url.slice(new URL(c.req.url).origin.length))
    if (!rel) throw new HTTPError(400, 'invalid path')
    const file = await files.resolve(rel), stat = await fs.lstat(file)
    if (!stat.isFile()) throw new HTTPError(404, 'not found')
    const data = Bun.file(file)
    const headers = new Headers({ 'Content-Type': data.type || 'application/octet-stream', 'Content-Length': String(stat.size), 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`, 'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes', 'Last-Modified': stat.mtime.toUTCString(), 'Content-Security-Policy': "default-src 'none'; sandbox" })
    const range = c.req.header('Range')
    if (range && c.req.method !== 'HEAD') {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range)
      let start = 0, end = stat.size - 1
      if (match?.[1]) { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end) }
      else if (match?.[2]) start = Math.max(0, stat.size - Number(match[2]))
      if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size || (match[1] === '' && Number(match[2]) === 0)) {
        headers.set('Content-Range', `bytes */${stat.size}`)
        headers.set('Content-Length', '0')
        return new Response(null, { status: 416, headers })
      }
      headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`)
      headers.set('Content-Length', String(end - start + 1))
      // Bun 1.4's native sendfile path can send the entire backing file for a
      // sliced BunFile (including its native stream). A transform prevents the
      // sendfile shortcut while keeping bounded, backpressured streaming.
      const stream = data.slice(start, end + 1).stream().pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { controller.enqueue(chunk) } }))
      return new Response(stream, { status: 206, headers })
    }
    return new Response(c.req.method === 'HEAD' ? null : data, { headers })
  })
  admin.use('/api/*', (c, next) => c.req.path === '/admin/api/login' ? next() : adminAuth(c, next))
  admin.post('/api/login', async (c) => {
    if (!rate(c, 'admin-login', 5, 5 * 60_000)) return c.json({ error: 'too many login attempts' }, 429)
    const body = await jsonBody(c)
    if (typeof body.password !== 'string' || !equal(body.password, options.adminPassword)) return c.json({ error: 'wrong password' }, 401)
    const requestOrigin = c.req.header('Origin')
    if (requestOrigin && requestOrigin !== origin(c)) return c.json({ error: 'invalid origin' }, 403)
    setCookie(c, ADMIN_COOKIE, issueAdmin(), { path: '/admin', sameSite: 'Lax', httpOnly: true, secure: options.secureCookies ?? origin(c).startsWith('https:'), maxAge: ADMIN_TTL / 1000 })
    return c.json({ ok: true })
  })
  admin.post('/api/logout', (c) => {
    const nonce = getCookie(c, ADMIN_COOKIE)?.split('.')[1]
    if (nonce) adminSessions.delete(nonce)
    setCookie(c, ADMIN_COOKIE, '', { path: '/admin', maxAge: 0 })
    return c.json({ ok: true })
  })
  admin.get('/api/session', (c) => c.json({ ok: true }))
  admin.get('/api/profile', (c) => c.json({ profile }))
  admin.post('/api/profile', (c) => mutate(async () => {
    const body = await jsonBody(c)
    const next = { name: typeof body.name === 'string' ? body.name.trim().slice(0, 64) : profile.name, email: typeof body.email === 'string' ? body.email.trim().slice(0, 128) : profile.email, avatar: typeof body.avatar === 'string' ? body.avatar.trim() : profile.avatar }
    if (next.avatar.length > 512 * 1024 || (next.avatar && !/^(https:\/\/|data:image\/(png|jpeg|gif|webp);base64,)/.test(next.avatar))) throw new HTTPError(400, 'invalid avatar')
    if (next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) throw new HTTPError(400, 'invalid email')
    await atomicJson(path.join(stateRoot, 'profile.json'), next); profile = next
    return c.json({ profile })
  }))
  admin.get('/api/stats', async (c) => {
    const stat = await fs.statfs(dataRoot)
    return c.json({ storage: { total: Number(stat.blocks) * Number(stat.bsize), available: Number(stat.bavail) * Number(stat.bsize), used: Number(stat.blocks - stat.bavail) * Number(stat.bsize) }, devices: tokens.length })
  })
  admin.get('/api/devices', (c) => c.json({ devices: tokens.map(({ id, name, createdAt }) => ({ id, name, createdAt })) }))
  admin.post('/api/devices/revoke', (c) => mutate(async () => {
    const body = await jsonBody(c), next = tokens.filter((t) => t.id !== body.id)
    await atomicJson(path.join(stateRoot, 'tokens.json'), { tokens: next }); tokens = next
    return c.json({ ok: true })
  }))
  admin.get('/api/device/:code', (c) => {
    if (!rate(c, 'device-admin', 30)) return c.json({ error: 'too many code attempts' }, 429)
    const { name, userCode, expiresAt, status } = findSession(c.req.param('code'))
    return c.json({ name, userCode, expiresAt, status })
  })
  admin.post('/api/device/approve', (c) => mutate(async () => {
    if (!rate(c, 'device-admin', 30)) return c.json({ error: 'too many code attempts' }, 429)
    const body = await jsonBody(c), session = findSession(String(body.user_code ?? ''))
    if (session.status !== 'pending') throw new HTTPError(409, 'already handled')
    const token = randomBytes(32).toString('base64url')
    const next = [...tokens, { id: randomUUID(), tokenHash: hash(token), name: session.name, createdAt: now() }]
    await atomicJson(path.join(stateRoot, 'tokens.json'), { tokens: next }); tokens = next
    session.status = 'approved'; session.token = token
    return c.json({ ok: true })
  }))
  admin.post('/api/device/deny', (c) => mutate(async () => {
    if (!rate(c, 'device-admin', 30)) return c.json({ error: 'too many code attempts' }, 429)
    const body = await jsonBody(c), session = findSession(String(body.user_code ?? ''))
    if (session.status !== 'pending') throw new HTTPError(409, 'already handled')
    session.status = 'denied'
    return c.json({ ok: true })
  }))
  const oss = await createOssService({ ...roots, auth: cloudAuth, clientFactory: options.ossClientFactory, withStateMutation: mutate })
  oss.registerAdmin(admin)
  const backups = await createBackupManager({ ...roots, withSnapshot: mutate, config: options.backupConfig ?? {}, runner: options.backupRunner })
  cloud.get('/api/backups/status', (c) => c.json(backups.status()))
  cloud.post('/api/backups/jobs', async (c) => {
    const body = await jsonBody(c)
    if (typeof body.kind !== 'string' || !['backup', 'check', 'verify', 'refresh'].includes(body.kind) ||
      (body.snapshotId !== undefined && typeof body.snapshotId !== 'string')) throw new HTTPError(400, 'invalid backup job request')
    return c.json(await backups.start({ kind: body.kind as BackupJobKind, snapshotId: body.snapshotId as string | undefined }), 202)
  })
  cloud.get('/api/backups/jobs/:id', (c) => c.json(backups.job(c.req.param('id'))))
  const adminDir = path.resolve(options.adminDir ?? path.join(import.meta.dir, '../public/admin'))
  admin.get('*', async (c) => {
    let rel: string
    try { rel = decodeURIComponent(c.req.path.replace(/^\/admin\/?/, '')) } catch { throw new HTTPError(400, 'invalid path') }
    if (rel.includes('\\') || rel.split('/').some((part) => part.startsWith('.'))) throw new HTTPError(400, 'invalid path')
    let file = path.resolve(adminDir, rel || 'index.html')
    if (file !== adminDir && !file.startsWith(adminDir + path.sep)) throw new HTTPError(400, 'invalid path')
    const stat = await fs.stat(file).catch(() => null)
    if (!stat?.isFile()) file = path.join(adminDir, 'index.html')
    if (!await fs.stat(file).then((s) => s.isFile(), () => false)) return c.text('admin bundle missing — run admin build', 404)
    const response = new Response(Bun.file(file))
    response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'")
    return response
  })
  root.route('/cloud', cloud); root.route('/admin', admin); root.route('/oss', oss.app)
  return root
}

const application = import.meta.main ? await createApplication({
  dataRoot: process.env.DATA_ROOT ?? './data', stateRoot: process.env.STATE_ROOT ?? './state',
  token: process.env.TOKEN ?? '', adminPassword: process.env.ADMIN_PASSWORD ?? '',
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 100 * 1024 ** 3),
  publicOrigin: process.env.PUBLIC_ORIGIN, trustProxy: process.env.TRUST_PROXY === '1',
  secureCookies: process.env.SECURE_COOKIES ? process.env.SECURE_COOKIES === '1' : undefined,
  backupConfig: backupConfigFromEnv(process.env),
}) : undefined
export default application ? {
  maxRequestBodySize: Number(process.env.MAX_UPLOAD_BYTES ?? 100 * 1024 ** 3),
  hostname: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3690),
  fetch: (request: Request, server: { requestIP(request: Request): { address: string } | null }) => application.fetch(request, { clientIp: server.requestIP(request)?.address }),
} : undefined
