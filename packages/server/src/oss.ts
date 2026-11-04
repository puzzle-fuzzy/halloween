import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { OssEntry } from '@halloween/contracts/oss'
import OSS from 'ali-oss'
import type { Context, Next } from 'hono'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { jsonBody } from './http'
import { atomicJson, HTTPError, migrateState, serialExecutor } from './storage'

export type { OssEntry } from '@halloween/contracts/oss'
export interface OssAccount {
  id: string
  name: string
  region: string
  accessKeyId: string
  accessKeySecret: string
}
interface Listing {
  objects?: { name: string; size?: number | string; lastModified?: string }[]
  prefixes?: string[]
  isTruncated?: boolean
  nextMarker?: string | null
}
interface ObjectMetadata {
  res: { headers: Record<string, string> }
  meta?: Record<string, string> | null
}
export interface OssClient {
  list(query: Record<string, unknown>, options: Record<string, unknown>): Promise<Listing>
  listBuckets(query: Record<string, unknown>): Promise<{
    buckets?: { name: string; region?: string; creationDate?: string | Date }[]
    isTruncated?: boolean
    nextMarker?: string
  }>
  signatureUrl(key: string, options: Record<string, unknown>): string
  head(key: string): Promise<ObjectMetadata>
  copy(to: string, from: string, options?: Record<string, unknown>): Promise<unknown>
  multipartUploadCopy(
    to: string,
    source: { sourceKey: string; sourceBucketName: string },
    options: Record<string, unknown>,
  ): Promise<unknown>
  abortMultipartUpload(key: string, uploadId: string): Promise<unknown>
  deleteMulti(keys: string[], options: { quiet: boolean }): Promise<{ deleted?: { Key: string }[] }>
  put(key: string, body: Buffer, options?: Record<string, unknown>): Promise<unknown>
}
export type OssClientFactory = (account: OssAccount, bucket?: string) => OssClient

function parseAccounts(raw: unknown): { accounts: OssAccount[] } {
  const accounts = (raw as { accounts?: unknown })?.accounts
  if (
    !Array.isArray(accounts) ||
    accounts.some(
      (a) =>
        !a ||
        ['id', 'name', 'region', 'accessKeyId', 'accessKeySecret'].some(
          (key) => typeof a[key] !== 'string' || !a[key],
        ),
    )
  )
    throw new Error('invalid OSS accounts')
  return { accounts }
}
function bucketName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value))
    throw new HTTPError(400, 'invalid bucket')
  return value
}
function objectKey(value: unknown, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    (!value && !allowEmpty) ||
    value.startsWith('/') ||
    value.includes('\0') ||
    Buffer.byteLength(value) > 1023
  )
    throw new HTTPError(400, 'invalid object key')
  return value
}
function continuation(result: Listing, previous?: string): string | undefined {
  if (!result.isTruncated) return undefined
  const candidates = [
    ...(result.objects ?? []).map((o) => o.name),
    ...(result.prefixes ?? []),
  ].sort()
  const next = result.nextMarker || candidates.at(-1)
  if (!next || next === previous || (previous && next < previous))
    throw new HTTPError(502, 'OSS pagination did not advance')
  return next
}

export async function createOssService(options: {
  dataRoot: string
  stateRoot: string
  auth: (c: Context, next: Next) => Promise<Response | void>
  clientFactory?: OssClientFactory
  withStateMutation?: <T>(work: () => Promise<T>) => Promise<T>
}) {
  let { accounts } = await migrateState(
    options.dataRoot,
    options.stateRoot,
    '.oss-accounts.json',
    'oss-accounts.json',
    parseAccounts,
    { accounts: [] },
  )
  const file = path.join(options.stateRoot, 'oss-accounts.json')
  const clients = new Map<string, OssClient>()
  const mutate = serialExecutor()
  const mutateState = options.withStateMutation ?? mutate
  const app = new Hono()
  const publicAccounts = () => accounts.map(({ id, name, region }) => ({ id, name, region }))
  function client(id: string, bucket?: string): OssClient {
    const account = accounts.find((a) => a.id === id)
    if (!account) throw new HTTPError(404, 'unknown oss account')
    if (bucket !== undefined && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket))
      throw new HTTPError(400, 'invalid bucket')
    const cacheKey = `${id}:${bucket ?? ''}`
    let result = clients.get(cacheKey)
    if (!result) {
      // Clients are immutable per bucket; concurrent requests cannot change their bucket.
      result =
        options.clientFactory?.(account, bucket) ??
        (new OSS({
          region: account.region,
          accessKeyId: account.accessKeyId,
          accessKeySecret: account.accessKeySecret,
          bucket,
          secure: true,
        }) as unknown as OssClient)
      clients.set(cacheKey, result)
    }
    return result
  }
  function forget(id: string) {
    for (const key of clients.keys()) if (key.startsWith(`${id}:`)) clients.delete(key)
  }
  async function exists(c: OssClient, key: string): Promise<boolean> {
    try {
      await c.head(key)
      return true
    } catch (error) {
      const e = error as { status?: number; code?: string }
      if (e.status === 404 || e.code === 'NoSuchKey') return false
      throw error
    }
  }
  async function allKeys(c: OssClient, prefix: string): Promise<string[]> {
    const keys = new Set<string>()
    let marker: string | undefined
    do {
      const result = await c.list({ prefix, 'max-keys': 1000, ...(marker ? { marker } : {}) }, {})
      for (const item of result.objects ?? []) keys.add(item.name)
      marker = continuation(result, marker)
    } while (marker)
    return [...keys]
  }
  async function removeKeys(c: OssClient, keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 900) {
      const batch = keys.slice(i, i + 900)
      // ali-oss drops individual Error elements: verify every verbose success ourselves.
      const result = await c.deleteMulti(batch, { quiet: false })
      const deleted = new Set((result.deleted ?? []).map((item) => item.Key))
      if (batch.some((key) => !deleted.has(key)))
        throw new HTTPError(502, 'OSS delete incomplete; some objects were not deleted')
    }
  }
  async function copyObject(
    store: OssClient,
    bucket: string,
    from: string,
    to: string,
    metadata: ObjectMetadata,
  ): Promise<void> {
    const sourceHeaders = metadata.res.headers
    const size = Number(sourceHeaders['content-length'])
    if (!Number.isSafeInteger(size) || size < 0)
      throw new HTTPError(502, 'OSS returned an invalid object size')
    const etag = sourceHeaders.etag
    const condition = etag ? { 'x-oss-copy-source-if-match': etag } : {}
    if (size <= 1024 ** 3) {
      await store.copy(to, from, {
        headers: { 'x-oss-forbid-overwrite': 'true', ...(etag ? { 'If-Match': etag } : {}) },
      })
      return
    }
    const headers: Record<string, string> = { 'x-oss-forbid-overwrite': 'true' }
    for (const key of [
      'cache-control',
      'content-disposition',
      'content-encoding',
      'content-language',
      'expires',
      'x-oss-storage-class',
    ]) {
      if (sourceHeaders[key]) headers[key] = sourceHeaders[key]
    }
    let uploadId: string | undefined
    try {
      await store.multipartUploadCopy(
        to,
        { sourceKey: from, sourceBucketName: bucket },
        {
          headers,
          copyheaders: condition,
          mime: sourceHeaders['content-type'],
          meta: metadata.meta ?? undefined,
          ...(sourceHeaders['x-oss-version-id'] && sourceHeaders['x-oss-version-id'] !== 'null'
            ? { versionId: sourceHeaders['x-oss-version-id'] }
            : {}),
          parallel: 3,
          partSize: 16 * 1024 * 1024,
          // completeMultipartUpload invokes progress(1, null, response).
          progress: (_progress: number, checkpoint: { uploadId?: string } | null) => {
            if (checkpoint?.uploadId) uploadId = checkpoint.uploadId
          },
        },
      )
    } catch (error) {
      if (uploadId) {
        try {
          await store.abortMultipartUpload(to, uploadId)
        } catch {
          console.warn('[oss] multipart cleanup failed; inspect incomplete uploads')
        }
      }
      throw error
    }
  }
  app.onError((error, c) => {
    if (error instanceof HTTPError)
      return c.json({ error: error.message }, error.status as ContentfulStatusCode)
    const e = error as { code?: string; status?: number }
    console.error('[oss]', e.code ?? error.name, e.status ?? '')
    const conflict = e.status === 409 || e.code === 'FileAlreadyExists'
    return c.json(
      { error: conflict ? 'target exists' : `OSS request failed${e.code ? ` (${e.code})` : ''}` },
      conflict ? 409 : 502,
    )
  })
  app.use('/api/*', options.auth)
  app.get('/api/accounts', (c) => c.json({ accounts: publicAccounts() }))
  app.get('/api/accounts/:id/buckets', async (c) => {
    const store = client(c.req.param('id')),
      buckets: { name: string; region?: string; createdAt: number }[] = []
    let marker: string | undefined
    do {
      const result = await store.listBuckets({ 'max-keys': 100, ...(marker ? { marker } : {}) })
      for (const b of result.buckets ?? [])
        buckets.push({
          name: b.name,
          region: b.region,
          createdAt: b.creationDate ? Date.parse(String(b.creationDate)) : 0,
        })
      if (!result.isTruncated) break
      const next = result.nextMarker || result.buckets?.at(-1)?.name
      if (!next || next === marker) throw new HTTPError(502, 'OSS pagination did not advance')
      marker = next
    } while (marker)
    return c.json({ buckets: buckets.sort((a, b) => a.name.localeCompare(b.name)) })
  })
  app.get('/api/accounts/:id/objects', async (c) => {
    const prefix = objectKey(c.req.query('prefix') ?? '', true),
      marker = c.req.query('marker')
    const result = await client(c.req.param('id'), c.req.query('bucket') ?? '').list(
      { prefix, delimiter: '/', 'max-keys': 1000, ...(marker ? { marker } : {}) },
      {},
    )
    const dirs = (result.prefixes ?? []).map(
      (p): OssEntry => ({
        name: p.slice(prefix.length).replace(/\/$/, ''),
        key: p,
        type: 'dir',
        size: 0,
        mtime: 0,
      }),
    )
    const files = (result.objects ?? [])
      .filter((o) => o.name !== prefix)
      .map(
        (o): OssEntry => ({
          name: o.name.slice(prefix.length),
          key: o.name,
          type: 'file',
          size: Number(o.size ?? 0),
          mtime: o.lastModified ? Date.parse(o.lastModified) : 0,
        }),
      )
    const entries = [...dirs, ...files].sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
    )
    return c.json({
      entries,
      truncated: Boolean(result.isTruncated),
      nextMarker: continuation(result, marker),
    })
  })
  app.post('/api/accounts/:id/sign', async (c) => {
    const body = await jsonBody(c),
      key = objectKey(body.key)
    const store = client(c.req.param('id'), bucketName(body.bucket))
    const method = body.method === 'PUT' ? 'PUT' : 'GET'
    if (method === 'PUT' && (await exists(store, key))) throw new HTTPError(409, 'target exists')
    const headers =
      method === 'PUT'
        ? { 'Content-Type': 'application/octet-stream', 'x-oss-forbid-overwrite': 'true' }
        : undefined
    const url = store.signatureUrl(key, {
      method,
      expires: method === 'PUT' ? 900 : 300,
      ...headers,
    })
    return c.json({ url, method, ...(headers ? { headers } : {}) })
  })
  app.post('/api/accounts/:id/delete', async (c) => {
    const body = await jsonBody(c)
    if (!Array.isArray(body.keys) || !body.keys.length)
      throw new HTTPError(400, 'bucket and keys required')
    const requested: string[] = body.keys.map((key: unknown) => objectKey(key))
    const bucket = bucketName(body.bucket),
      store = client(c.req.param('id'), bucket)
    return mutate(async () => {
      const keys = new Set<string>()
      for (const key of requested)
        for (const item of key.endsWith('/') ? await allKeys(store, key) : [key]) keys.add(item)
      await removeKeys(store, [...keys])
      return c.json({ ok: true, deleted: keys.size })
    })
  })
  app.post('/api/accounts/:id/rename', async (c) => {
    const body = await jsonBody(c),
      from = objectKey(body.from)
    let to = objectKey(body.to)
    const directory = from.endsWith('/')
    if (directory && !to.endsWith('/')) to += '/'
    if (from === to || (directory && to.startsWith(from)))
      throw new HTTPError(400, 'invalid rename target')
    const bucket = bucketName(body.bucket),
      store = client(c.req.param('id'), bucket)
    return mutate(async () => {
      const sources = directory
        ? await allKeys(store, from)
        : (await exists(store, from))
          ? [from]
          : []
      if (!sources.length) throw new HTTPError(404, 'not found')
      if (directory ? (await allKeys(store, to)).length > 0 : await exists(store, to))
        throw new HTTPError(409, 'target exists')
      const moves: { from: string; to: string; metadata: ObjectMetadata }[] = []
      for (const key of sources)
        moves.push({
          from: key,
          to: directory ? to + key.slice(from.length) : to,
          metadata: await store.head(key),
        })
      for (const move of moves)
        if (await exists(store, move.to)) throw new HTTPError(409, 'target exists')
      // A failed copy leaves all sources intact. Do not delete until every copy succeeded.
      for (const move of moves) await copyObject(store, bucket, move.from, move.to, move.metadata)
      // Avoid deleting a newer source written while a long multipart copy ran.
      for (const move of moves) {
        const current = (await store.head(move.from)).res.headers,
          previous = move.metadata.res.headers
        if (
          ['etag', 'content-length', 'last-modified', 'x-oss-version-id'].some(
            (key) => current[key] !== previous[key],
          )
        )
          throw new HTTPError(409, 'source changed during rename; copies retained')
      }
      await removeKeys(store, sources)
      return c.json({ ok: true })
    })
  })
  app.post('/api/accounts/:id/mkdir', async (c) => {
    const body = await jsonBody(c),
      key = objectKey(body.key)
    const directory = key.endsWith('/') ? key : `${key}/`,
      store = client(c.req.param('id'), bucketName(body.bucket))
    if (await exists(store, directory)) throw new HTTPError(409, 'target exists')
    await store.put(directory, Buffer.alloc(0), { headers: { 'x-oss-forbid-overwrite': 'true' } })
    return c.json({ ok: true })
  })
  function registerAdmin(admin: Hono) {
    admin.get('/api/oss-accounts', (c) => c.json({ accounts: publicAccounts() }))
    admin.post('/api/oss-accounts', (c) =>
      mutateState(async () => {
        const body = await jsonBody(c)
        if (
          ['name', 'region', 'accessKeyId', 'accessKeySecret'].some(
            (key) => typeof body[key] !== 'string' || !body[key].trim(),
          )
        )
          throw new HTTPError(400, 'name, region, accessKeyId, accessKeySecret required')
        const account: OssAccount = {
          id: randomUUID(),
          name: String(body.name).trim().slice(0, 128),
          region: String(body.region).trim(),
          accessKeyId: String(body.accessKeyId).trim(),
          accessKeySecret: String(body.accessKeySecret).trim(),
        }
        const next = [...accounts, account]
        await atomicJson(file, { accounts: next })
        accounts = next
        return c.json({ ok: true, id: account.id })
      }),
    )
    admin.post('/api/oss-accounts/update', (c) =>
      mutateState(async () => {
        const body = await jsonBody(c),
          account = accounts.find((a) => a.id === body.id)
        if (!account) throw new HTTPError(404, 'unknown account')
        const next = { ...account }
        for (const key of ['name', 'region', 'accessKeyId', 'accessKeySecret'] as const)
          if (typeof body[key] === 'string' && body[key].trim()) next[key] = body[key].trim()
        const updated = accounts.map((a) => (a.id === account.id ? next : a))
        await atomicJson(file, { accounts: updated })
        accounts = updated
        forget(account.id)
        return c.json({ ok: true })
      }),
    )
    admin.post('/api/oss-accounts/delete', (c) =>
      mutateState(async () => {
        const body = await jsonBody(c),
          next = accounts.filter((a) => a.id !== body.id)
        await atomicJson(file, { accounts: next })
        accounts = next
        forget(String(body.id))
        return c.json({ ok: true })
      }),
    )
  }
  return { app, registerAdmin }
}
