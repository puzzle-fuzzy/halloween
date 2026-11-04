import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ApplicationOptions } from '../src/index'
import { createApplication } from '../src/index'
import type { OssClient } from '../src/oss'

// Assertions below validate response fields; the dynamic JSON boundary stays local to tests.
interface AuditResponse extends Response {
  json(): Promise<any>
}
const TOKEN = 'audit-master-token-'.repeat(3)
const PASSWORD = 'audit-admin-password-123'
const temporary: string[] = []
afterEach(async () => {
  for (const root of temporary.splice(0)) await fs.rm(root, { recursive: true, force: true })
})
async function roots() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'halloween-test-'))
  temporary.push(root)
  const dataRoot = path.join(root, 'data'),
    stateRoot = path.join(root, 'state')
  await fs.mkdir(dataRoot)
  return { root, dataRoot, stateRoot }
}
async function fixture(
  extra: Partial<ApplicationOptions> = {},
  existing?: Awaited<ReturnType<typeof roots>>,
) {
  const dirs = existing ?? (await roots())
  const app = await createApplication({
    ...dirs,
    token: TOKEN,
    adminPassword: PASSWORD,
    quiet: true,
    ...extra,
  })
  async function call(
    url: string,
    options: {
      method?: string
      json?: unknown
      body?: string
      token?: string | null
      cookie?: string
      headers?: Record<string, string>
    } = {},
  ) {
    const headers = new Headers(options.headers)
    if (options.token !== null) headers.set('Authorization', `Bearer ${options.token ?? TOKEN}`)
    if (options.cookie) headers.set('Cookie', options.cookie)
    if (options.json !== undefined) headers.set('Content-Type', 'application/json')
    return (await app.fetch(
      new Request(url.startsWith('http') ? url : `http://audit.local${url}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.json === undefined ? options.body : JSON.stringify(options.json),
      }),
    )) as AuditResponse
  }
  return { ...dirs, app, call }
}
async function authorize(f: Awaited<ReturnType<typeof fixture>>, name = 'My test Mac') {
  const flow = await (
    await f.call('/cloud/api/device/code', { method: 'POST', json: { name }, token: null })
  ).json()
  await f.call('/admin/api/device/approve', { method: 'POST', json: { user_code: flow.user_code } })
  const { token } = await (
    await f.call('/cloud/api/device/token', {
      method: 'POST',
      json: { device_code: flow.device_code },
      token: null,
    })
  ).json()
  return { ...flow, token }
}

describe('private state and filesystem boundary', () => {
  test.skipIf(process.platform === 'win32')(
    'migrates old credentials outside the cloud root, hashes tokens, and blocks original download',
    async () => {
      const dirs = await roots()
      await fs.writeFile(
        path.join(dirs.dataRoot, '.tokens.json'),
        JSON.stringify({
          tokens: [{ id: 'one', token: 'legacy-device', name: 'old', createdAt: 1 }],
        }),
      )
      await fs.writeFile(
        path.join(dirs.dataRoot, '.oss-accounts.json'),
        JSON.stringify({
          accounts: [
            {
              id: 'oss',
              name: 'my account',
              region: 'oss-cn-test',
              accessKeyId: 'FAKE_ID',
              accessKeySecret: 'FAKE_SECRET',
            },
          ],
        }),
      )
      const f = await fixture({}, dirs)
      expect((await f.call('/cloud/api/profile', { token: 'legacy-device' })).status).toBe(200)
      const tokens = await fs.readFile(path.join(f.stateRoot, 'tokens.json'), 'utf8')
      expect(tokens).not.toContain('legacy-device')
      expect(JSON.parse(tokens).tokens[0].tokenHash).toMatch(/^[a-f0-9]{64}$/)
      expect(await fs.readdir(f.dataRoot)).toEqual([])
      for (const name of ['.tokens.json', '.oss-accounts.json', '.profile.json'])
        expect((await f.call(`/cloud/f/${name}`)).status).toBe(400)
      expect((await fs.stat(f.stateRoot)).mode & 0o777).toBe(0o700)
      expect((await fs.stat(path.join(f.stateRoot, 'tokens.json'))).mode & 0o777).toBe(0o600)
      const next = await fixture({}, dirs)
      expect((await next.call('/cloud/api/profile', { token: 'legacy-device' })).status).toBe(200)
    },
  )
  test('corrupt state prevents startup and is preserved', async () => {
    const dirs = await roots()
    await fs.mkdir(dirs.stateRoot)
    await fs.writeFile(path.join(dirs.stateRoot, 'tokens.json'), '{broken')
    await expect(fixture({}, dirs)).rejects.toThrow('Invalid state')
    expect(await fs.readFile(path.join(dirs.stateRoot, 'tokens.json'), 'utf8')).toBe('{broken')
  })
  test('different legacy and migrated state fails closed without discarding either', async () => {
    const dirs = await roots()
    await fs.mkdir(dirs.stateRoot)
    await fs.writeFile(
      path.join(dirs.dataRoot, '.profile.json'),
      JSON.stringify({ name: 'old', email: '', avatar: '' }),
    )
    await fs.writeFile(
      path.join(dirs.stateRoot, 'profile.json'),
      JSON.stringify({ name: 'new', email: '', avatar: '' }),
    )
    await expect(fixture({}, dirs)).rejects.toThrow('different contents')
    expect(await fs.stat(path.join(dirs.dataRoot, '.profile.json'))).toBeDefined()
  })
  test('rejects overlapping roots, including symlink aliases', async () => {
    const dirs = await roots()
    await expect(fixture({ stateRoot: path.join(dirs.dataRoot, 'private') }, dirs)).rejects.toThrow(
      'non-overlapping',
    )
    const alias = path.join(dirs.root, 'alias')
    await fs.symlink(dirs.dataRoot, alias)
    await expect(fixture({ stateRoot: alias }, dirs)).rejects.toThrow('non-overlapping')
  })
  test('rejects hidden paths, traversal, and symlink escapes for every file operation', async () => {
    const f = await fixture()
    const outside = path.join(f.root, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'secret'), 'PRIVATE')
    await fs.symlink(outside, path.join(f.dataRoot, 'link'))
    for (const bad of [
      '/link',
      '/../outside',
      '/.profile.json',
      '/safe/../outside',
      '/safe/.tokens.json',
    ]) {
      expect((await f.call(`/cloud/api/files?path=${encodeURIComponent(bad)}`)).status).toBe(400)
      expect(
        (await f.call('/cloud/api/mkdir', { method: 'POST', json: { path: bad } })).status,
      ).toBe(400)
      expect(
        (await f.call('/cloud/api/rename', { method: 'POST', json: { from: bad, to: '/new' } }))
          .status,
      ).toBe(400)
      expect(
        (await f.call('/cloud/api/delete', { method: 'POST', json: { paths: [bad] } })).status,
      ).toBe(400)
      expect(
        (
          await f.call(`/cloud/api/upload?path=${encodeURIComponent(bad)}&name=x`, {
            method: 'POST',
            body: 'x',
          })
        ).status,
      ).toBe(400)
    }
    expect((await f.call('/cloud/f/link/secret')).status).toBe(400)
    expect(
      (
        await f.call('/cloud/api/preview-ticket', {
          method: 'POST',
          json: { path: '/link/secret' },
        })
      ).status,
    ).toBe(400)
    expect(await fs.readFile(path.join(outside, 'secret'), 'utf8')).toBe('PRIVATE')
    expect((await (await f.call('/cloud/api/files')).json()).entries).toEqual([])
  })
})

describe('cloud data safety', () => {
  test('untrusted uploaded HTML is sandboxed on full, HEAD and Range responses', async () => {
    const f = await fixture()
    expect(
      (
        await f.call('/cloud/api/upload?name=untrusted.html', {
          method: 'POST',
          body: '<script>fetch("/admin/api/devices")</script>',
        })
      ).status,
    ).toBe(200)
    for (const options of [{}, { method: 'HEAD' }, { headers: { Range: 'bytes=0-7' } }]) {
      const response = await f.call('/cloud/f/untrusted.html', options)
      expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox")
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    }
  })
  test('serves HEAD and byte ranges needed for media seeking', async () => {
    const f = await fixture()
    await fs.writeFile(path.join(f.dataRoot, 'video.bin'), '0123456789')
    const partial = await f.call('/cloud/f/video.bin', { headers: { Range: 'bytes=3-6' } })
    expect(partial.status).toBe(206)
    expect(partial.headers.get('Content-Range')).toBe('bytes 3-6/10')
    expect(await partial.text()).toBe('3456')
    expect(
      await (await f.call('/cloud/f/video.bin', { headers: { Range: 'bytes=-3' } })).text(),
    ).toBe('789')
    const invalid = await f.call('/cloud/f/video.bin', { headers: { Range: 'bytes=30-' } })
    expect(invalid.status).toBe(416)
    expect(invalid.headers.get('Content-Range')).toBe('bytes */10')
    const head = await f.call('/cloud/f/video.bin', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('Content-Length')).toBe('10')
    expect(await head.text()).toBe('')
  })
  test('real Bun HTTP preserves range bytes and enforces the request body limit', async () => {
    const f = await fixture()
    await fs.writeFile(path.join(f.dataRoot, 'video.bin'), '0123456789')
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      maxRequestBodySize: 16,
      fetch: (request) => f.app.fetch(request),
    })
    try {
      const response = await fetch(new URL('/cloud/f/video.bin', server.url), {
        headers: { Authorization: `Bearer ${TOKEN}`, Range: 'bytes=2-4' },
      })
      expect(response.status).toBe(206)
      expect(response.headers.get('Content-Length')).toBe('3')
      expect(await response.text()).toBe('234')
      const tooBig = await fetch(new URL('/cloud/api/upload?name=too-big', server.url), {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: 'x'.repeat(17),
      })
      expect(tooBig.status).toBe(413)
    } finally {
      server.stop(true)
    }
  })
  test('enforces the configured upload size while streaming and cleans its temporary file', async () => {
    const f = await fixture({ maxUploadBytes: 4 })
    expect(
      (await f.call('/cloud/api/upload?name=too-big', { method: 'POST', body: '12345' })).status,
    ).toBe(413)
    expect(await fs.readdir(f.dataRoot)).toEqual([])
    expect(
      (await f.call('/cloud/api/upload?name=fits', { method: 'POST', body: '1234' })).status,
    ).toBe(200)
  })
  test('upload/list/download/rename/search/trash retains recoverable contents', async () => {
    const f = await fixture()
    expect(
      (await f.call('/cloud/api/mkdir', { method: 'POST', json: { path: '/folder/nested' } }))
        .status,
    ).toBe(200)
    expect(
      (
        await f.call('/cloud/api/upload?path=/folder/nested&name=hello.txt', {
          method: 'POST',
          body: 'hello audit',
        })
      ).status,
    ).toBe(200)
    expect(await (await f.call('/cloud/f/folder/nested/hello.txt')).text()).toBe('hello audit')
    expect(
      (
        await f.call('/cloud/api/rename', {
          method: 'POST',
          json: { from: '/folder/nested/hello.txt', to: '/folder/nested/renamed.txt' },
        })
      ).status,
    ).toBe(200)
    expect((await (await f.call('/cloud/api/search?q=renamed')).json()).entries[0].path).toBe(
      '/folder/nested/renamed.txt',
    )
    const response = await f.call('/cloud/api/delete', {
      method: 'POST',
      json: { paths: ['/folder', '/folder/nested/renamed.txt'] },
    })
    const result = await response.json()
    expect(result.deleted).toBe(1)
    const trash = path.join(f.stateRoot, 'trash', result.trashIds[0])
    expect(
      JSON.parse(await fs.readFile(path.join(trash, 'manifest.json'), 'utf8')).originalPath,
    ).toBe('/folder')
    expect(await fs.readFile(path.join(trash, 'content/nested/renamed.txt'), 'utf8')).toBe(
      'hello audit',
    )
    expect(await fs.readdir(f.dataRoot)).toEqual([])
    await fs.rename(path.join(trash, 'content'), path.join(f.dataRoot, 'folder'))
    expect(await (await f.call('/cloud/f/folder/nested/renamed.txt')).text()).toBe('hello audit')
  })
  test('same-name and concurrent uploads never overwrite existing data', async () => {
    const f = await fixture()
    const first = await f.call('/cloud/api/upload?name=same.txt', { method: 'POST', body: 'first' })
    expect(first.status).toBe(200)
    expect(
      (await f.call('/cloud/api/upload?name=same.txt', { method: 'POST', body: 'second' })).status,
    ).toBe(409)
    expect(await fs.readFile(path.join(f.dataRoot, 'same.txt'), 'utf8')).toBe('first')
    const results = await Promise.all(
      ['a', 'b'].map((body) => f.call('/cloud/api/upload?name=race.txt', { method: 'POST', body })),
    )
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    expect((await fs.readdir(f.dataRoot)).sort()).toEqual(['race.txt', 'same.txt'])
  })
  test('interrupted upload removes partial files and does not create a target', async () => {
    const f = await fixture()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'))
        controller.error(new Error('connection lost'))
      },
    })
    const response = await f.app.fetch(
      new Request('http://audit.local/cloud/api/upload?name=interrupted.txt', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
        body,
      }),
    )
    expect(response.status).toBe(500)
    expect(await fs.readdir(f.dataRoot)).toEqual([])
  })
  test('rename conflicts and deletion of root are rejected', async () => {
    const f = await fixture()
    await fs.writeFile(path.join(f.dataRoot, 'a'), 'A')
    await fs.writeFile(path.join(f.dataRoot, 'b'), 'B')
    expect(
      (await f.call('/cloud/api/rename', { method: 'POST', json: { from: '/a', to: '/b' } }))
        .status,
    ).toBe(409)
    expect(
      (await f.call('/cloud/api/delete', { method: 'POST', json: { paths: ['/'] } })).status,
    ).toBe(400)
    expect(await fs.readFile(path.join(f.dataRoot, 'b'), 'utf8')).toBe('B')
  })
})

describe('device authorization and sessions', () => {
  test('rejects malformed/non-object/oversized public JSON bodies before route handling', async () => {
    const f = await fixture()
    for (const body of ['{invalid', 'null', '[]', '"string"']) {
      expect(
        (await f.call('/cloud/api/device/code', { method: 'POST', body, token: null })).status,
      ).toBe(400)
      expect((await f.call('/admin/api/login', { method: 'POST', body, token: null })).status).toBe(
        400,
      )
    }
    expect(
      (
        await f.call('/cloud/api/device/code', {
          method: 'POST',
          json: { name: 'x'.repeat(5000) },
          token: null,
        })
      ).status,
    ).toBe(413)
    expect(
      (
        await f.call('/admin/api/login', {
          method: 'POST',
          json: { password: 'x'.repeat(1024 * 1024 + 1) },
          token: null,
        })
      ).status,
    ).toBe(413)
    expect(
      (await f.call('/oss/api/accounts/id/sign', { method: 'POST', body: 'null' })).status,
    ).toBe(400)
  })
  test('requires explicit approval, then supports revocation', async () => {
    const f = await fixture()
    expect((await f.call('/cloud/api/profile', { token: null })).status).toBe(401)
    const flow = await (
      await f.call('/cloud/api/device/code', {
        method: 'POST',
        json: { name: 'My Mac' },
        token: null,
      })
    ).json()
    expect((await f.call(`/admin/api/device/${flow.user_code}`, { token: null })).status).toBe(401)
    const details = await (await f.call(`/admin/api/device/${flow.user_code}`)).json()
    expect(details.name).toBe('My Mac')
    expect(details.status).toBe('pending')
    expect(
      (
        await (
          await f.call('/cloud/api/device/token', {
            method: 'POST',
            json: { device_code: flow.device_code },
            token: null,
          })
        ).json()
      ).status,
    ).toBe('pending')
    expect(
      (
        await f.call('/admin/api/device/approve', {
          method: 'POST',
          json: { user_code: flow.user_code },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await f.call('/admin/api/device/approve', {
          method: 'POST',
          json: { user_code: flow.user_code },
        })
      ).status,
    ).toBe(409)
    const { token } = await (
      await f.call('/cloud/api/device/token', {
        method: 'POST',
        json: { device_code: flow.device_code },
        token: null,
      })
    ).json()
    expect((await f.call('/cloud/api/profile', { token })).status).toBe(200)
    expect(await fs.readFile(path.join(f.stateRoot, 'tokens.json'), 'utf8')).not.toContain(token)
    const { devices } = await (await f.call('/admin/api/devices')).json()
    await f.call('/admin/api/devices/revoke', { method: 'POST', json: { id: devices[0].id } })
    expect((await f.call('/cloud/api/profile', { token })).status).toBe(401)
  })
  test('denial and expiry terminate polling without issuing a token', async () => {
    let now = Date.now()
    const f = await fixture({ now: () => now })
    const code = async () =>
      (await f.call('/cloud/api/device/code', { method: 'POST', json: {}, token: null })).json()
    const denied = await code()
    await f.call('/admin/api/device/deny', {
      method: 'POST',
      json: { user_code: denied.user_code },
    })
    expect(
      (
        await f.call('/cloud/api/device/token', {
          method: 'POST',
          json: { device_code: denied.device_code },
          token: null,
        })
      ).status,
    ).toBe(403)
    const expired = await code()
    now += 600_001
    expect(
      (
        await f.call('/cloud/api/device/token', {
          method: 'POST',
          json: { device_code: expired.device_code },
          token: null,
        })
      ).status,
    ).toBe(410)
  })
  test('colliding human codes are never assigned to a second session', async () => {
    const f = await fixture({ userCode: () => '123456' })
    expect(
      (await f.call('/cloud/api/device/code', { method: 'POST', json: {}, token: null })).status,
    ).toBe(200)
    expect(
      (await f.call('/cloud/api/device/code', { method: 'POST', json: {}, token: null })).status,
    ).toBe(503)
  })
  test('rate limits password guessing and resets after its window', async () => {
    let now = Date.now()
    const f = await fixture({ now: () => now })
    for (let i = 0; i < 5; i++)
      expect(
        (
          await f.call('/admin/api/login', {
            method: 'POST',
            json: { password: 'bad' },
            token: null,
          })
        ).status,
      ).toBe(401)
    expect(
      (
        await f.call('/admin/api/login', {
          method: 'POST',
          json: { password: PASSWORD },
          token: null,
        })
      ).status,
    ).toBe(429)
    now += 300_001
    expect(
      (
        await f.call('/admin/api/login', {
          method: 'POST',
          json: { password: PASSWORD },
          token: null,
        })
      ).status,
    ).toBe(200)
  })
  test('secure session cookies are unforgeable and logout revokes the actual session', async () => {
    const f = await fixture({ publicOrigin: 'https://audit.local' })
    const response = await f.call('/admin/api/login', {
      method: 'POST',
      json: { password: PASSWORD },
      token: null,
    })
    const setCookie = response.headers.get('set-cookie')!
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('HttpOnly')
    const cookie = setCookie.split(';')[0]!
    expect((await f.call('/admin/api/session', { token: null, cookie })).status).toBe(200)
    expect(
      (await f.call('/admin/api/session', { token: null, cookie: `${cookie}tamper` })).status,
    ).toBe(401)
    expect(
      (
        await f.call('/admin/api/device/deny', {
          token: null,
          cookie,
          method: 'POST',
          json: { user_code: '000000' },
          headers: { Origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403)
    await f.call('/admin/api/logout', { token: null, cookie, method: 'POST' })
    expect((await f.call('/admin/api/session', { token: null, cookie })).status).toBe(401)
  })
  test('preview tickets expire, are file-scoped, and work through nginx original URI forwarding', async () => {
    let now = Date.now()
    const f = await fixture({ now: () => now })
    await fs.writeFile(path.join(f.dataRoot, 'one.txt'), 'ONE')
    await fs.writeFile(path.join(f.dataRoot, 'two.txt'), 'TWO')
    const { token } = await authorize(f)
    const { url } = await (
      await f.call('/cloud/api/preview-ticket', {
        method: 'POST',
        json: { path: '/one.txt' },
        token,
      })
    ).json()
    expect(url).not.toContain(token)
    expect(await (await f.call(url, { token: null })).text()).toBe('ONE')
    expect((await f.call(url.replace('/one.txt?', '/two.txt?'), { token: null })).status).toBe(401)
    const original = new URL(url)
    expect(
      (
        await f.call('/cloud/api/check', {
          token: null,
          headers: { 'X-Original-URI': original.pathname + original.search },
        })
      ).status,
    ).toBe(200)
    expect((await f.call(`/cloud/api/files${original.search}`, { token: null })).status).toBe(401)
    now += 300_001
    expect((await f.call(url, { token: null })).status).toBe(401)
  })
})

class FakeOss implements OssClient {
  objects = new Map<string, string>()
  sizes = new Map<string, number>()
  events: string[] = []
  failCopy = ''
  failDelete = ''
  signatureOptions: Record<string, unknown> = {}
  multipartOptions: Record<string, unknown> = {}
  aborted: string[] = []
  afterCopy?: () => void
  async list(query: Record<string, unknown>) {
    const prefix = String(query.prefix ?? ''),
      marker = String(query.marker ?? '')
    const candidates = new Map<string, 'dir' | 'file'>()
    for (const key of this.objects.keys())
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length),
          slash = query.delimiter ? rest.indexOf('/') : -1
        candidates.set(
          slash >= 0 ? prefix + rest.slice(0, slash + 1) : key,
          slash >= 0 ? 'dir' : 'file',
        )
      }
    const keys = [...candidates.keys()].filter((key) => key > marker).sort(),
      page = keys.slice(0, 2)
    return {
      objects: page
        .filter((key) => candidates.get(key) === 'file')
        .map((name) => ({ name, size: this.objects.get(name)?.length ?? 0 })),
      prefixes: page.filter((key) => candidates.get(key) === 'dir'),
      isTruncated: keys.length > 2,
      nextMarker: keys.length > 2 ? page.at(-1) : undefined,
    }
  }
  async listBuckets() {
    return { buckets: [{ name: 'test-bucket' }] }
  }
  signatureUrl(key: string, options: Record<string, unknown>) {
    this.signatureOptions = options
    return `https://fake.invalid/${key}`
  }
  async head(key: string) {
    if (!this.objects.has(key)) throw Object.assign(new Error('missing'), { status: 404 })
    return {
      res: {
        headers: {
          'content-length': String(this.sizes.get(key) ?? this.objects.get(key)!.length),
          etag: JSON.stringify(this.objects.get(key)),
          'content-type': 'video/mp4',
          'content-disposition': 'inline',
        },
      },
      meta: { caption: 'original metadata' },
    }
  }
  async copy(to: string, from: string) {
    this.events.push(`copy:${from}`)
    if (from === this.failCopy) throw new Error('copy failed')
    if (this.objects.has(to)) throw Object.assign(new Error('exists'), { status: 409 })
    this.objects.set(to, this.objects.get(from)!)
    this.afterCopy?.()
    return {}
  }
  async multipartUploadCopy(
    to: string,
    source: { sourceKey: string; sourceBucketName: string },
    options: Record<string, unknown>,
  ) {
    this.events.push(`multipart:${source.sourceKey}`)
    this.multipartOptions = options
    const progress = options.progress as (
      progress: number,
      checkpoint: { uploadId: string } | null,
    ) => void
    progress(0, { uploadId: 'fake-upload-id' })
    if (source.sourceKey === this.failCopy) throw new Error('multipart copy failed')
    if (this.objects.has(to)) throw Object.assign(new Error('exists'), { status: 409 })
    this.objects.set(to, this.objects.get(source.sourceKey)!)
    this.sizes.set(to, this.sizes.get(source.sourceKey)!)
    this.afterCopy?.()
    progress(1, null)
    return {}
  }
  async abortMultipartUpload(key: string, uploadId: string) {
    this.aborted.push(`${key}:${uploadId}`)
    return {}
  }
  async deleteMulti(keys: string[], options: { quiet: boolean }) {
    expect(options.quiet).toBe(false)
    this.events.push(`delete:${keys.join(',')}`)
    const deleted = keys.filter((key) => key !== this.failDelete)
    for (const key of deleted) this.objects.delete(key)
    return { deleted: deleted.map((Key) => ({ Key })) }
  }
  async put(key: string, value: Buffer) {
    this.objects.set(key, value.toString())
    return {}
  }
}
async function ossFixture() {
  const store = new FakeOss(),
    factoryCalls: (string | undefined)[] = []
  const f = await fixture({
    ossClientFactory: (_account, bucket) => {
      factoryCalls.push(bucket)
      return store
    },
  })
  const { id } = await (
    await f.call('/admin/api/oss-accounts', {
      method: 'POST',
      json: {
        name: 'Fake account',
        region: 'oss-cn-test',
        accessKeyId: 'FAKE',
        accessKeySecret: 'FAKE_SECRET',
      },
    })
  ).json()
  const base = `/oss/api/accounts/${id}`
  return {
    ...f,
    store,
    base,
    factoryCalls,
    op: (operation: string, json: Record<string, unknown>) =>
      f.call(`${base}/${operation}`, { method: 'POST', json: { bucket: 'test-bucket', ...json } }),
  }
}
describe('OSS with fake clients, without network access', () => {
  test('returns a continuation marker and lists subsequent pages', async () => {
    const f = await ossFixture()
    for (const key of ['a', 'b', 'c', 'd', 'e']) f.store.objects.set(key, key)
    const first = await (await f.call(`${f.base}/objects?bucket=test-bucket`)).json()
    expect(first.entries.map((entry: { key: string }) => entry.key)).toEqual(['a', 'b'])
    expect(first.truncated).toBe(true)
    expect(first.nextMarker).toBe('b')
    const second = await (
      await f.call(`${f.base}/objects?bucket=test-bucket&marker=${first.nextMarker}`)
    ).json()
    expect(second.entries.map((entry: { key: string }) => entry.key)).toEqual(['c', 'd'])
  })
  test('recursive directory rename copies every page before any source deletion', async () => {
    const f = await ossFixture()
    for (const key of ['old/', 'old/a', 'old/sub/b', 'old/sub/c', 'unrelated'])
      f.store.objects.set(key, key)
    expect((await f.op('rename', { from: 'old/', to: 'new/' })).status).toBe(200)
    expect([...f.store.objects.keys()].sort()).toEqual([
      'new/',
      'new/a',
      'new/sub/b',
      'new/sub/c',
      'unrelated',
    ])
    expect(f.store.events.slice(0, 4).every((event) => event.startsWith('copy:'))).toBe(true)
    expect(f.store.events[4]).toStartWith('delete:')
  })
  test('failed copy preserves every source, and a preexisting destination is rejected', async () => {
    const f = await ossFixture()
    for (const key of ['old/a', 'old/b', 'old/c']) f.store.objects.set(key, key)
    f.store.failCopy = 'old/b'
    expect((await f.op('rename', { from: 'old/', to: 'new/' })).status).toBe(502)
    for (const key of ['old/a', 'old/b', 'old/c']) expect(f.store.objects.has(key)).toBe(true)
    expect(f.store.events.some((event) => event.startsWith('delete:'))).toBe(false)
    expect((await f.op('rename', { from: 'old/', to: 'new/' })).status).toBe(409)
  })
  test('large video rename uses multipart copy with metadata, source condition and no-overwrite', async () => {
    const f = await ossFixture()
    f.store.objects.set('video.mp4', 'video')
    f.store.sizes.set('video.mp4', 2 * 1024 ** 3)
    expect((await f.op('rename', { from: 'video.mp4', to: 'renamed.mp4' })).status).toBe(200)
    expect(f.store.objects.has('video.mp4')).toBe(false)
    expect(f.store.objects.get('renamed.mp4')).toBe('video')
    expect(f.store.events[0]).toBe('multipart:video.mp4')
    expect(f.store.events[1]).toStartWith('delete:')
    expect(f.store.multipartOptions.mime).toBe('video/mp4')
    expect(f.store.multipartOptions.meta).toEqual({ caption: 'original metadata' })
    expect(f.store.multipartOptions.headers).toEqual({
      'x-oss-forbid-overwrite': 'true',
      'content-disposition': 'inline',
    })
    expect(f.store.multipartOptions.copyheaders).toEqual({
      'x-oss-copy-source-if-match': '"video"',
    })
  })
  test('multipart failure aborts incomplete upload and never deletes source objects', async () => {
    const f = await ossFixture()
    f.store.objects.set('folder/a', 'small')
    f.store.objects.set('folder/video.mp4', 'video')
    f.store.sizes.set('folder/video.mp4', 2 * 1024 ** 3)
    f.store.failCopy = 'folder/video.mp4'
    expect((await f.op('rename', { from: 'folder/', to: 'new/' })).status).toBe(502)
    expect(f.store.objects.has('folder/a')).toBe(true)
    expect(f.store.objects.has('folder/video.mp4')).toBe(true)
    expect(f.store.aborted).toEqual(['new/video.mp4:fake-upload-id'])
    expect(f.store.events.some((event) => event.startsWith('delete:'))).toBe(false)
  })
  test('a source changed during copying is preserved and the operation reports a conflict', async () => {
    const f = await ossFixture()
    f.store.objects.set('source', 'old')
    f.store.afterCopy = () => {
      f.store.objects.set('source', 'newly changed contents')
    }
    expect((await f.op('rename', { from: 'source', to: 'destination' })).status).toBe(409)
    expect(f.store.objects.get('source')).toBe('newly changed contents')
    expect(f.store.objects.get('destination')).toBe('old')
    expect(f.store.events.some((event) => event.startsWith('delete:'))).toBe(false)
  })
  test('recursive delete traverses all pages and does not falsely report partial deletion success', async () => {
    const f = await ossFixture()
    for (const key of ['folder/', 'folder/a', 'folder/b', 'folder/c', 'other'])
      f.store.objects.set(key, key)
    f.store.failDelete = 'folder/b'
    expect((await f.op('delete', { keys: ['folder/'] })).status).toBe(502)
    expect(f.store.objects.has('folder/b')).toBe(true)
    expect(f.store.objects.has('other')).toBe(true)
    f.store.failDelete = ''
    expect((await f.op('delete', { keys: ['folder/'] })).status).toBe(200)
    expect([...f.store.objects.keys()]).toEqual(['other'])
  })
  test('signed uploads reject conflicts and bind a no-overwrite header', async () => {
    const f = await ossFixture()
    f.store.objects.set('exists', 'keep')
    expect((await f.op('sign', { key: 'exists', method: 'PUT' })).status).toBe(409)
    const response = await f.op('sign', { key: 'new', method: 'PUT' })
    const result = await response.json()
    expect(result.headers['x-oss-forbid-overwrite']).toBe('true')
    expect(f.store.signatureOptions['x-oss-forbid-overwrite']).toBe('true')
    expect(f.store.signatureOptions['Content-Type']).toBe('application/octet-stream')
  })
  test('clients are cached separately for each bucket and credentials are not exposed', async () => {
    const f = await ossFixture()
    await Promise.all(
      ['test-bucket', 'other-bucket'].map((bucket) => f.call(`${f.base}/objects?bucket=${bucket}`)),
    )
    expect(f.factoryCalls.sort()).toEqual(['other-bucket', 'test-bucket'])
    expect(await (await f.call('/oss/api/accounts')).text()).not.toContain('FAKE_SECRET')
    expect(await (await f.call('/admin/api/oss-accounts')).text()).not.toContain('FAKE_SECRET')
    expect((await f.call('/cloud/f/.oss-accounts.json')).status).toBe(400)
  })
})
