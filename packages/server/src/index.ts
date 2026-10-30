import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { logger } from 'hono/logger'
import { getCookie } from 'hono/cookie'

const PORT = Number(process.env.PORT ?? 3690)
const DATA_ROOT = path.resolve(process.env.DATA_ROOT ?? './data')
const TOKEN = process.env.TOKEN ?? ''

if (!TOKEN) {
  console.error('[server] env TOKEN is required')
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

// all cloud endpoints live under /cloud — nginx routes the whole prefix here,
// so future services can share the same domain (halloween.yxswy.com)
const app = new Hono().basePath('/cloud')

app.use(logger())

app.onError((err, c) => {
  if (err instanceof HTTPError) {
    return c.json({ error: err.message }, err.status as ContentfulStatusCode)
  }
  console.error(err)
  return c.json({ error: 'internal error' }, 500)
})

// bearer token (API clients), cookie, or ?token= query (direct media URLs)
async function auth(c: Context, next: Next) {
  const header = c.req.header('Authorization')
  const token =
    header?.startsWith('Bearer ')
      ? header.slice(7)
      : (getCookie(c, 'halloween_token') ?? c.req.query('token'))
  if (token !== TOKEN) return c.json({ error: 'unauthorized' }, 401)
  await next()
}

app.get('/api/health', (c) => c.json({ ok: true }))

app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/health') return next()
  return auth(c, next)
})

app.use('/f/*', auth)

// directory listing
app.get('/api/files', async (c) => {
  const dir = resolveSafe(c.req.query('path') ?? '/')
  const st = await fs.stat(dir).catch(() => null)
  if (!st) throw new HTTPError(404, 'not found')
  if (!st.isDirectory()) throw new HTTPError(400, 'not a directory')
  const dirents = await fs.readdir(dir, { withFileTypes: true })
  const entries = await Promise.all(
    dirents
      .filter((d) => !d.name.startsWith('.'))
      .map((d) =>
        statEntry(dir, d.name, path.posix.join(safeDecode(c.req.query('path') ?? '/'), d.name))
      )
  )
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
  )
  return c.json({ entries })
})

// upload: raw body streamed to disk, name via query param (percent-encoded)
app.post('/api/upload', async (c) => {
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

app.post('/api/mkdir', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const dir = resolveSafe((body as { path?: string }).path ?? '')
  if (dir === DATA_ROOT) throw new HTTPError(400, 'invalid path')
  await fs.mkdir(dir, { recursive: true })
  return c.json({ ok: true })
})

app.post('/api/rename', async (c) => {
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

app.post('/api/delete', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const paths = (body as { paths?: string[] }).paths ?? []
  for (const rel of paths) {
    const abs = resolveSafe(rel)
    if (abs === DATA_ROOT) continue
    await fs.rm(abs, { recursive: true, force: true })
  }
  return c.json({ ok: true, deleted: paths.length })
})

// recursive filename search, capped
app.get('/api/search', async (c) => {
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

// auth probe for nginx auth_request
app.get('/api/check', (c) => c.json({ ok: true }))

// raw file stream; in production nginx takes /cloud/f/ over (alias + auth_request)
app.get('/f/*', async (c) => {
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

export default {
  port: PORT,
  fetch: app.fetch,
}
