import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Hono } from 'hono'
import { createRssService } from '../src/rss'
import type { RssOptions, RssService } from '../src/rss'

const RSS_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>RSS Channel</title>
  <item><guid>g1</guid><title>Post &amp; One</title><link>https://example.com/1</link>
    <pubDate>Mon, 02 Jan 2026 03:04:05 GMT</pubDate><description>&lt;b&gt;bold&lt;/b&gt; summary &amp;amp; more</description></item>
  <item><guid>g2</guid><title>Dupe Key</title><link>https://example.com/2</link><pubDate>Sun, 01 Dec 2025 03:04:05 GMT</pubDate><description>second</description></item>
  <item><guid>g2</guid><title>Dupe Key (same guid — dropped)</title><link>https://example.com/2b</link><description>dropped</description></item>
</channel></rss>`

const ATOM_XML = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Channel</title>
  <entry><id>tag:example.com,2026:e1</id><title>Atom Entry</title>
    <link rel="alternate" href="https://example.com/a1"/><link rel="self" href="https://example.com/feed"/>
    <published>2026-02-03T04:05:06Z</published><summary>atom summary</summary></entry>
</feed>`

const RDF_XML = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel><title>RDF Channel</title></channel>
  <item><title>RDF Item</title><link>https://example.com/r1</link><dc:date>2026-03-04T05:06:07Z</dc:date><description>rdf summary</description></item>
</rdf:RDF>`

const temporary: string[] = []
const stopped: RssService[] = []
afterEach(async () => {
  for (const service of stopped.splice(0)) service.stop()
  for (const root of temporary.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

interface Harness {
  service: RssService
  admin: Hono
  cloud: Hono
  fetched: string[]
  respond: (body: string, status?: number, headers?: Record<string, string>) => void
  setDns: (address: string) => void
}

async function harness(feedXml: string, options?: { legacyFeeds?: unknown; refreshIntervalMs?: number }): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'halloween-rss-'))
  temporary.push(root)
  const dataRoot = path.join(root, 'data')
  const stateRoot = path.join(root, 'state')
  await fs.mkdir(dataRoot)
  await fs.mkdir(stateRoot)
  if (options?.legacyFeeds !== undefined) {
    await fs.writeFile(path.join(stateRoot, '.rss-feeds.json'), JSON.stringify(options.legacyFeeds), 'utf-8')
  }
  let body = feedXml
  let status = 200
  let headers: Record<string, string> = {}
  const fetched: string[] = []
  let dnsAddress = '93.184.216.34'
  const fetcher = (async (url: string | URL | Request) => {
    fetched.push(String(url))
    return new Response(body, { status, headers })
  }) as typeof fetch
  const dnsLookup = (async () => [{ address: dnsAddress, family: 4 }]) as RssOptions['dnsLookup']
  const service = await createRssService({
    dataRoot,
    stateRoot,
    fetcher,
    dnsLookup,
    refreshOnStart: false,
    refreshIntervalMs: options?.refreshIntervalMs,
    quiet: true,
  })
  stopped.push(service)
  const admin = new Hono()
  const cloud = new Hono()
  service.registerAdmin(admin)
  service.registerCloud(cloud)
  return {
    service,
    admin,
    cloud,
    fetched,
    respond(nextBody: string, nextStatus = 200, nextHeaders: Record<string, string> = {}) {
      body = nextBody
      status = nextStatus
      headers = nextHeaders
    },
    setDns(address: string) {
      dnsAddress = address
    },
  }
}

async function addFeed(h: Harness, url = 'https://feed.example.com/xml'): Promise<string> {
  const res = await h.admin.request('/api/rss/feeds', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'test feed', url }),
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as { id: string }).id
}

async function listItems(h: Harness) {
  const res = await h.cloud.request('/api/rss/items')
  return (await res.json()) as { refreshedAt: number; items: Array<Record<string, unknown>> }
}

describe('rss parsing (RSS 2.0 / Atom / RDF)', () => {
  test('RSS 2.0: unescapes entities, strips html, parses dates, drops duplicate guids', async () => {
    const h = await harness(RSS_XML)
    await addFeed(h)
    await h.service.refreshNow()
    const { items } = await listItems(h)
    expect(items).toHaveLength(2)
    expect(items[0]!.title).toBe('Post & One')
    expect(items[0]!.summary).toBe('bold summary & more')
    expect(items[0]!.link).toBe('https://example.com/1')
    expect(items[0]!.publishedAt).toBe(Date.parse('Mon, 02 Jan 2026 03:04:05 GMT'))
    expect(items[0]!.feedTitle).toBe('test feed') // explicit title wins over channel title
  })

  test('Atom: prefers rel=alternate link, uses entry id as key', async () => {
    const h = await harness(ATOM_XML)
    await addFeed(h)
    await h.service.refreshNow()
    const { items } = await listItems(h)
    expect(items).toHaveLength(1)
    expect(items[0]!.link).toBe('https://example.com/a1')
    expect(items[0]!.publishedAt).toBe(Date.parse('2026-02-03T04:05:06Z'))
  })

  test('RDF: the item link doubles as the stable key', async () => {
    const h = await harness(RDF_XML)
    await addFeed(h)
    await h.service.refreshNow()
    const { items } = await listItems(h)
    expect(items).toHaveLength(1)
    expect(items[0]!.id).toContain('https://example.com/r1')
    expect(items[0]!.publishedAt).toBe(Date.parse('2026-03-04T05:06:07Z'))
  })

  test('unsupported format surfaces an error without wiping the cache', async () => {
    const h = await harness(RSS_XML)
    const id = await addFeed(h)
    await h.service.refreshNow()
    h.respond('{"not":"a feed"}')
    await h.service.refreshNow()
    const { items } = await listItems(h)
    expect(items.length).toBeGreaterThan(0) // previous items survive
    const list = await (await h.admin.request('/api/rss/feeds')).json() as { feeds: Array<{ id: string; ok: boolean; error: string }> }
    const feed = list.feeds.find((f) => f.id === id)!
    expect(feed.ok).toBe(false)
    expect(feed.error).toContain('unsupported feed format')
  })
})

describe('rss admin CRUD + persistence', () => {
  test('add/update/delete persist atomically to rss-feeds.json', async () => {
    const h = await harness(RSS_XML)
    const id = await addFeed(h)
    const root = temporary.at(-1)!
    const file = path.join(root, 'state', 'rss-feeds.json')
    const saved = JSON.parse(await fs.readFile(file, 'utf-8')) as { feeds: Array<{ id: string; url: string; enabled: boolean }> }
    expect(saved.feeds).toHaveLength(1)
    expect(saved.feeds[0]!.enabled).toBe(true)

    const bad = await h.admin.request('/api/rss/feeds/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, url: 'ftp://nope' }),
    })
    expect(bad.status).toBe(400)

    const ok = await h.admin.request('/api/rss/feeds/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, title: 'renamed', enabled: false }),
    })
    expect(ok.status).toBe(200)
    const list = await (await h.admin.request('/api/rss/feeds')).json() as { feeds: Array<{ id: string; title: string; enabled: boolean }> }
    expect(list.feeds[0]!.title).toBe('renamed')
    expect(list.feeds[0]!.enabled).toBe(false)

    await h.admin.request('/api/rss/feeds/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const after = await (await h.admin.request('/api/rss/feeds')).json() as { feeds: unknown[] }
    expect(after.feeds).toHaveLength(0)
  })

  test('legacy .rss-feeds.json migrates to the plain name; conflicting copies fail closed', async () => {
    const h = await harness(RSS_XML, { legacyFeeds: { feeds: [{ id: 'legacy', title: 'old', url: 'https://example.com/feed', enabled: true, createdAt: 1 }] } })
    const list = await (await h.admin.request('/api/rss/feeds')).json() as { feeds: Array<{ id: string }> }
    expect(list.feeds.map((f) => f.id)).toEqual(['legacy'])
    const root = temporary.at(-1)!
    expect(await fs.exists(path.join(root, 'state', 'rss-feeds.json'))).toBe(true)
    expect(await fs.exists(path.join(root, 'state', '.rss-feeds.json'))).toBe(false)
    void h
  })
})

describe('rss SSRF guard', () => {
  test('IP-literal internal host is refused before any fetch', async () => {
    const h = await harness(RSS_XML)
    await addFeed(h, 'http://127.0.0.1:3690/cloud/api/health')
    await h.service.refreshNow()
    expect(h.fetched).toHaveLength(0)
    const list = await (await h.admin.request('/api/rss/feeds')).json() as { feeds: Array<{ error: string }> }
    expect(list.feeds[0]!.error).toBe('feed host is a blocked address')
  })

  test('hostname resolving to a private address is refused', async () => {
    const h = await harness(RSS_XML)
    h.setDns('192.168.1.10')
    await addFeed(h, 'https://internal.example.com/feed')
    await h.service.refreshNow()
    expect(h.fetched).toHaveLength(0)
    const list = await (await h.admin.request('/api/rss/feeds')).json() as { feeds: Array<{ error: string }> }
    expect(list.feeds[0]!.error).toBe('feed host resolves to a blocked address')
  })

  test('a redirect hop into the internal network is refused', async () => {
    const h = await harness('')
    // first hop is public and answers 302 → internal target; the guard must
    // block the second hop before the fetcher sees it
    h.respond('', 302, { location: 'http://10.0.0.5/feed' })
    await addFeed(h, 'https://public.example.com/feed')
    await h.service.refreshNow()
    expect(h.fetched).toEqual(['https://public.example.com/feed']) // exactly one hop, second blocked
    const list = await (await h.admin.request('/api/rss/feeds')).json() as { feeds: Array<{ error: string }> }
    expect(list.feeds[0]!.error).toBe('feed host is a blocked address')
  })
})

describe('rss service lifecycle', () => {
  test('the timer refreshes on schedule and stop() freezes it', async () => {
    const h = await harness(RSS_XML, { refreshIntervalMs: 20 })
    await addFeed(h)
    expect(h.fetched).toHaveLength(0) // refreshOnStart: false
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(h.fetched.length).toBeGreaterThan(0) // interval fired
    h.service.stop()
    const frozen = h.fetched.length
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(h.fetched.length).toBe(frozen) // no further refresh after stop
  })

  test('two services in different roots are fully isolated', async () => {
    const a = await harness(RSS_XML)
    const b = await harness(ATOM_XML)
    await addFeed(a)
    const listB = await (await b.admin.request('/api/rss/feeds')).json() as { feeds: unknown[] }
    expect(listB.feeds).toHaveLength(0)
  })
})
