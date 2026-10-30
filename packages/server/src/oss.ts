import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import OSS from 'ali-oss'
import { Hono } from 'hono'
import type { Context, Next } from 'hono'

export interface OssAccount {
  id: string
  name: string
  region: string
  accessKeyId: string
  accessKeySecret: string
}

export interface OssEntry {
  name: string
  key: string
  type: 'dir' | 'file'
  size: number
  mtime: number
}

interface Options {
  dataRoot: string
  auth: (c: Context, next: Next) => Promise<Response | void>
}

let accounts: OssAccount[] = []
const clients = new Map<string, OSS>()
let opts: Options

function accountsFile(): string {
  return path.join(opts.dataRoot, '.oss-accounts.json')
}

async function loadAccounts(): Promise<void> {
  try {
    const raw = JSON.parse(await fs.readFile(accountsFile(), 'utf-8')) as { accounts?: OssAccount[] }
    accounts = raw.accounts ?? []
  } catch {
    accounts = []
  }
}

async function saveAccounts(): Promise<void> {
  await fs.writeFile(accountsFile(), JSON.stringify({ accounts }, null, 2), 'utf-8')
}

function publicAccounts() {
  return accounts.map(({ id, name, region }) => ({ id, name, region }))
}

function findAccount(id: string): OssAccount | undefined {
  return accounts.find((a) => a.id === id)
}

function clientFor(account: OssAccount): OSS {
  let client = clients.get(account.id)
  if (!client) {
    client = new OSS({
      region: account.region,
      accessKeyId: account.accessKeyId,
      accessKeySecret: account.accessKeySecret,
      secure: true,
    })
    clients.set(account.id, client)
  }
  return client
}

function needAccount(id: string): OssAccount {
  const account = findAccount(id)
  if (!account) throw new Error('unknown oss account')
  return account
}

/** the client-facing OSS proxy API, mounted at /oss */
export function createOssApp(options: Options): Hono {
  opts = options
  void loadAccounts()

  const app = new Hono()

  // surface ali-oss errors (code/status) instead of a generic 500
  app.onError((err, c) => {
    const e = err as { status?: number; code?: string; name?: string; message?: string }
    if (String(e.message).includes('unknown oss account')) {
      return c.json({ error: 'unknown oss account' }, 404)
    }
    console.error('[oss]', e.code ?? e.name ?? '', e.message ?? String(err))
    const detail = [e.code ?? e.name, e.status ? `HTTP ${e.status}` : '']
      .filter(Boolean)
      .join(' ')
    return c.json({ error: detail || 'oss error' }, 502)
  })

  app.use('/api/*', options.auth)

  app.get('/api/accounts', (c) => c.json({ accounts: publicAccounts() }))

  app.get('/api/accounts/:id/buckets', async (c) => {
    const account = needAccount(c.req.param('id'))
    // typings say Bucket[], runtime returns { buckets, res, isTruncated }
    const result = (await clientFor(account).listBuckets({ 'max-keys': 200 })) as unknown as {
      buckets?: { name: string; region?: string; creationDate?: string | Date }[]
    }
    const buckets = (result.buckets ?? []).map(
      (b: { name: string; region?: string; creationDate?: string | Date }): {
        name: string
        region?: string
        createdAt: number
      } => ({
        name: b.name,
        region: b.region,
        createdAt: b.creationDate ? Date.parse(String(b.creationDate)) : 0,
      })
    )
    buckets.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))
    return c.json({ buckets })
  })

  app.get('/api/accounts/:id/objects', async (c) => {
    const account = needAccount(c.req.param('id'))
    const bucket = c.req.query('bucket') ?? ''
    if (!bucket) return c.json({ error: 'bucket required' }, 400)
    const prefix = c.req.query('prefix') ?? ''
    const client = clientFor(account)
    client.useBucket(bucket)
    const result = await client.list(
      {
        prefix,
        delimiter: '/',
        'max-keys': 1000,
      },
      {}
    )
    const dirs = (result.prefixes ?? []).map((p): OssEntry => {
      const label = p.slice(prefix.length).replace(/\/$/, '')
      return { name: label, key: p, type: 'dir', size: 0, mtime: 0 }
    })
    const files = (result.objects ?? [])
      .filter((o) => o.name !== prefix)
      .map((o): OssEntry => ({
        name: o.name.slice(prefix.length),
        key: o.name,
        type: 'file',
        size: Number(o.size ?? 0),
        mtime: o.lastModified ? Date.parse(String(o.lastModified)) : 0,
      }))
    const entries = [...dirs, ...files].sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
    )
    return c.json({ entries, truncated: Boolean(result.isTruncated) })
  })

  // signed direct-to-OSS URLs: traffic never passes through this server
  app.post('/api/accounts/:id/sign', async (c) => {
    const account = needAccount(c.req.param('id'))
    const body = await c.req.json().catch(() => ({}))
    const { bucket, key } = body as { bucket?: string; key?: string }
    const method = (body as { method?: string }).method === 'PUT' ? 'PUT' : 'GET'
    if (!bucket || !key) return c.json({ error: 'bucket and key required' }, 400)
    const client = clientFor(account)
    client.useBucket(bucket)
    const url = client.signatureUrl(key, {
      method,
      expires: method === 'PUT' ? 15 * 60 : 60 * 60,
      ...(method === 'PUT' ? { contentType: 'application/octet-stream' } : {}),
    })
    return c.json({ url, method })
  })

  app.post('/api/accounts/:id/delete', async (c) => {
    const account = needAccount(c.req.param('id'))
    const body = await c.req.json().catch(() => ({}))
    const { bucket, keys } = body as { bucket?: string; keys?: string[] }
    if (!bucket || !keys || keys.length === 0) return c.json({ error: 'bucket and keys required' }, 400)
    const client = clientFor(account)
    client.useBucket(bucket)
    for (let i = 0; i < keys.length; i += 900) {
      await client.deleteMulti(keys.slice(i, i + 900), { quiet: true })
    }
    return c.json({ ok: true, deleted: keys.length })
  })

  app.post('/api/accounts/:id/rename', async (c) => {
    const account = needAccount(c.req.param('id'))
    const body = await c.req.json().catch(() => ({}))
    const { bucket, from, to } = body as { bucket?: string; from?: string; to?: string }
    if (!bucket || !from || !to) return c.json({ error: 'bucket, from, to required' }, 400)
    const client = clientFor(account)
    client.useBucket(bucket)
    await client.copy(to, from)
    await client.delete(from)
    return c.json({ ok: true })
  })

  app.post('/api/accounts/:id/mkdir', async (c) => {
    const account = needAccount(c.req.param('id'))
    const body = await c.req.json().catch(() => ({}))
    const { bucket, key } = body as { bucket?: string; key?: string }
    if (!bucket || !key) return c.json({ error: 'bucket and key required' }, 400)
    const client = clientFor(account)
    client.useBucket(bucket)
    await client.put(key.endsWith('/') ? key : `${key}/`, Buffer.alloc(0))
    return c.json({ ok: true })
  })

  return app
}

/** admin-side account credential management; credentials never leave the server.
 * auth comes from the admin app's /api/* middleware */
export function registerOssAdmin(app: Hono): void {
  app.get('/api/oss-accounts', (c) => c.json({ accounts: publicAccounts() }))

  app.post('/api/oss-accounts', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const { name, region, accessKeyId, accessKeySecret } = body as Record<string, string>
    if (!name || !region || !accessKeyId || !accessKeySecret) {
      return c.json({ error: 'name, region, accessKeyId, accessKeySecret required' }, 400)
    }
    const account: OssAccount = { id: randomUUID(), name, region, accessKeyId, accessKeySecret }
    accounts.push(account)
    await saveAccounts()
    return c.json({ ok: true, id: account.id })
  })

  app.post('/api/oss-accounts/update', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const { id, name, region, accessKeyId, accessKeySecret } = body as Record<string, string>
    const account = findAccount(id ?? '')
    if (!account) return c.json({ error: 'unknown account' }, 404)
    const next = {
      ...account,
      ...(name ? { name } : {}),
      ...(region ? { region } : {}),
      ...(accessKeyId ? { accessKeyId } : {}),
      ...(accessKeySecret ? { accessKeySecret } : {}),
    }
    accounts = accounts.map((a) => (a.id === id ? next : a))
    clients.delete(id)
    await saveAccounts()
    return c.json({ ok: true })
  })

  app.post('/api/oss-accounts/delete', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const id = (body as { id?: string }).id ?? ''
    accounts = accounts.filter((a) => a.id !== id)
    clients.delete(id)
    await saveAccounts()
    return c.json({ ok: true })
  })
}
