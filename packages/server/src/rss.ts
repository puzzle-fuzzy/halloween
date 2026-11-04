import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import fs from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import type { RssFeed, RssItem } from '@halloween/contracts/rss'
import { XMLParser } from 'fast-xml-parser'
import type { Hono } from 'hono'
import { atomicJson, migrateState } from './storage'

export type { RssFeed, RssItem }

interface FeedSnapshot {
  fetchedAt: number
  ok: boolean
  error: string
  /** channel title as advertised by the feed */
  feedTitle: string
  /** on fetch failure the previous items are kept, so clients never see a gap */
  items: RssItem[]
}

interface RssCache {
  refreshedAt: number
  byFeed: Record<string, FeedSnapshot>
}

const REFRESH_INTERVAL_MS = 30 * 60 * 1000
const FETCH_TIMEOUT_MS = 15 * 1000
const MAX_BODY_CHARS = 2 * 1024 * 1024
const MAX_ITEMS_PER_FEED = 100
const MAX_ITEMS_TOTAL = 300
const MAX_REDIRECTS = 3

const FEEDS_NAME = 'rss-feeds.json'
const CACHE_NAME = 'rss-cache.json'

export interface RssService {
  /** client endpoint on the cloud app — serves the server-side cache, never fetches live */
  registerCloud(app: Hono): void
  /** admin feed management; auth comes from the admin app's /api/* middleware */
  registerAdmin(app: Hono): void
  refreshNow(): Promise<void>
  /** clear the refresh timer; the service must not be used afterwards */
  stop(): void
}

export interface RssOptions {
  dataRoot: string
  stateRoot: string
  now?: () => number
  /** injectable transport for tests */
  fetcher?: typeof fetch
  dnsLookup?: DnsLookup
  refreshIntervalMs?: number
  /** default true; tests disable it and drive refreshNow() themselves */
  refreshOnStart?: boolean
  quiet?: boolean
}

/** narrow slice of dns.lookup — enough for the SSRF guard, easy to stub */
type DnsLookup = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>

// ------------------------------------------------------------- xml parsing

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' })

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}

/** xml values come back as string | number | { '#text': … } | arrays of those */
function textOf(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (typeof v === 'object')
    return textOf(Array.isArray(v) ? v[0] : (v as Record<string, unknown>)['#text'])
  return ''
}

/** atom links are objects with @href/@rel — prefer rel="alternate" (the human page) */
function atomLink(v: unknown): string {
  for (const link of asArray(v as Record<string, unknown>)) {
    if (link && typeof link === 'object') {
      const o = link as Record<string, unknown>
      const rel = o['@rel']
      if (!rel || rel === 'alternate') return String(o['@href'] ?? '')
    } else if (typeof link === 'string') {
      return link
    }
  }
  return ''
}

function stripHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function parseTime(v: string): number {
  if (!v) return 0
  const t = Date.parse(v)
  return Number.isNaN(t) ? 0 : t
}

interface RawItem {
  key: string
  title: string
  link: string
  publishedAt: number
  summary: string
}

/** supports RSS 2.0, Atom and RDF/RSS 1.0 */
function parseFeed(body: string): { feedTitle: string; items: RawItem[] } {
  const doc = xml.parse(body) as Record<string, unknown>

  const channel = (doc.rss as Record<string, unknown> | undefined)?.channel as
    | Record<string, unknown>
    | undefined
  if (channel) {
    return {
      feedTitle: stripHtml(textOf(channel.title)),
      items: asArray(channel.item).map((raw): RawItem => {
        const it = raw as Record<string, unknown>
        const link = textOf(it.link)
        return {
          key: textOf(it.guid) || link,
          title: stripHtml(textOf(it.title)) || link,
          link,
          publishedAt: parseTime(textOf(it.pubDate)) || parseTime(textOf(it['dc:date'])),
          summary: stripHtml(textOf(it.description)),
        }
      }),
    }
  }

  const atom = doc.feed as Record<string, unknown> | undefined
  if (atom) {
    return {
      feedTitle: stripHtml(textOf(atom.title)),
      items: asArray(atom.entry).map((raw): RawItem => {
        const it = raw as Record<string, unknown>
        const link = atomLink(it.link)
        return {
          key: textOf(it.id) || link,
          title: stripHtml(textOf(it.title)) || link,
          link,
          publishedAt: parseTime(textOf(it.published)) || parseTime(textOf(it.updated)),
          summary: stripHtml(textOf(it.summary) || textOf(it.content)),
        }
      }),
    }
  }

  const rdf = doc['rdf:RDF'] as Record<string, unknown> | undefined
  if (rdf) {
    const channelTitle = (rdf.channel as Record<string, unknown> | undefined)?.title
    return {
      feedTitle: stripHtml(textOf(channelTitle)),
      items: asArray(rdf.item).map((raw): RawItem => {
        const it = raw as Record<string, unknown>
        const link = textOf(it.link)
        return {
          key: link, // rdf items have no guid — the link is the stable key
          title: stripHtml(textOf(it.title)) || link,
          link,
          publishedAt: parseTime(textOf(it['dc:date'])) || parseTime(textOf(it.date)),
          summary: stripHtml(textOf(it.description)),
        }
      }),
    }
  }

  throw new Error('unsupported feed format (expected RSS 2.0, Atom or RDF)')
}

// ------------------------------------------------------------- ssrf guard

/** [start, end] as unsigned 32-bit values */
const BLOCKED_V4: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 0x00000000], // 0.0.0.0/8 "this host"
  [0x0a000000, 0x0affffff], // 10/8 private
  [0x64400000, 0x647fffff], // 100.64/10 CGNAT
  [0x7f000000, 0x7fffffff], // 127/8 loopback
  [0xa9fe0000, 0xa9feffff], // 169.254/16 link-local (incl. cloud metadata)
  [0xac100000, 0xac1fffff], // 172.16/12 private
  [0xc0a80000, 0xc0a8ffff], // 192.168/16 private
  [0xc6120000, 0xc613ffff], // 198.18/15 benchmark
  [0xe0000000, 0xffffffff], // 224/4 multicast + 240/4 reserved
]

/** loopback / private / link-local (incl. cloud metadata) / CGNAT / multicast-reserved ranges */
export function isBlockedAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b, c, d] = ip.split('.').map(Number) as [number, number, number, number]
    const value = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
    return BLOCKED_V4.some(([lo, hi]) => value >= lo && value <= hi)
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase()
    if (lower === '::' || lower === '::1') return true
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isBlockedAddress(mapped[1]!)
    const first = Number.parseInt(lower.split(':')[0] || '0', 16)
    if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
    if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true // ff00::/8 multicast
    return false
  }
  return true // not an IP literal at all — refuse
}

/**
 * SSRF guard for feed fetching: resolve the host and refuse anything that
 * lands on a non-public address. Redirects are followed manually so a 30x
 * cannot pivot the request into the internal network.
 *
 * Residual risk: the resolver runs again inside fetch() — a rebinding DNS
 * server can flip answers inside that window. Acceptable for a personal
 * server; pinning the connection to the validated IP would break TLS SNI.
 */
async function assertPublicFeedUrl(target: URL, dnsLookup: DnsLookup): Promise<void> {
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new Error('only http(s) feed URLs are supported')
  }
  const host = target.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new Error('feed host is a blocked address')
    return
  }
  const records = await dnsLookup(host, { all: true })
  if (records.length === 0) throw new Error('feed host did not resolve')
  for (const record of records) {
    if (isBlockedAddress(record.address)) throw new Error('feed host resolves to a blocked address')
  }
}

async function fetchFeedResponse(
  feedUrl: string,
  fetcher: typeof fetch,
  dnsLookup: DnsLookup,
): Promise<Response> {
  let target = feedUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicFeedUrl(new URL(target), dnsLookup)
    const res = await fetcher(target, {
      headers: { 'User-Agent': 'halloween-rss/1.0' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'manual',
    })
    if (res.status < 300 || res.status >= 400) return res
    const location = res.headers.get('location')
    if (!location) return res
    target = new URL(location, target).toString()
  }
  throw new Error(`too many redirects (> ${MAX_REDIRECTS})`)
}

// ------------------------------------------------------------------ service

function parseFeedsState(raw: unknown): { feeds: RssFeed[] } {
  const feeds = (raw as { feeds?: unknown } | null | undefined)?.feeds
  if (!Array.isArray(feeds)) throw new Error('invalid rss-feeds state')
  return {
    feeds: feeds.map((f) => ({ ...(f as RssFeed), enabled: (f as RssFeed).enabled !== false })),
  }
}

export async function createRssService(options: RssOptions): Promise<RssService> {
  const now = options.now ?? Date.now
  const fetcher = options.fetcher ?? fetch
  const dnsLookup =
    options.dnsLookup ?? ((hostname, lookupOptions) => lookup(hostname, lookupOptions))
  const feedsFile = path.join(options.stateRoot, FEEDS_NAME)
  const cacheFile = path.join(options.stateRoot, CACHE_NAME)

  // rss state belongs in stateRoot, not the user-visible cloud data root.
  // Feeds are the user's source of truth → fail-closed migration when two
  // copies disagree; the cache is regenerable → tolerant soft migration.
  await migrateState(
    options.stateRoot,
    options.stateRoot,
    `.${FEEDS_NAME}`,
    FEEDS_NAME,
    parseFeedsState,
    { feeds: [] },
  )
  const { feeds } = await migrateState(
    options.dataRoot,
    options.stateRoot,
    `.${FEEDS_NAME}`,
    FEEDS_NAME,
    parseFeedsState,
    { feeds: [] },
  )

  let cache: RssCache = { refreshedAt: 0, byFeed: {} }
  {
    let raw: Partial<RssCache> | undefined
    for (const file of [cacheFile, path.join(options.stateRoot, `.${CACHE_NAME}`)]) {
      try {
        raw = JSON.parse(await fs.readFile(file, 'utf-8')) as Partial<RssCache>
        break
      } catch {
        /* try the legacy name, then start empty */
      }
    }
    const byFeed: RssCache['byFeed'] = {}
    for (const [id, snap] of Object.entries(raw?.byFeed ?? {})) {
      if (snap && typeof snap === 'object' && Array.isArray(snap.items)) byFeed[id] = snap
    }
    cache = { refreshedAt: raw?.refreshedAt ?? 0, byFeed }
  }

  let inflight: Promise<void> | null = null

  async function saveFeeds(): Promise<void> {
    await atomicJson(feedsFile, { feeds })
  }
  async function saveCache(): Promise<void> {
    await atomicJson(cacheFile, cache)
  }

  async function fetchFeed(feed: RssFeed): Promise<FeedSnapshot> {
    const fetchedAt = now()
    try {
      const res = await fetchFeedResponse(feed.url, fetcher, dnsLookup)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { feedTitle, items } = parseFeed((await res.text()).slice(0, MAX_BODY_CHARS))
      const seen = new Set<string>()
      const mapped: RssItem[] = []
      for (const raw of items) {
        if (!raw.key || seen.has(raw.key)) continue
        seen.add(raw.key)
        mapped.push({
          id: `${feed.id}:${raw.key}`,
          feedId: feed.id,
          feedTitle: feed.title || feedTitle || feed.url,
          title: raw.title,
          link: raw.link,
          publishedAt: raw.publishedAt || fetchedAt,
          summary: raw.summary.slice(0, 300),
        })
        if (mapped.length >= MAX_ITEMS_PER_FEED) break
      }
      return { fetchedAt, ok: true, error: '', feedTitle, items: mapped }
    } catch (err) {
      return {
        fetchedAt,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        feedTitle: '',
        items: [],
      }
    }
  }

  async function doRefresh(): Promise<void> {
    await Promise.all(
      feeds
        .filter((f) => f.enabled)
        .map(async (feed) => {
          const snap = await fetchFeed(feed)
          const prev = cache.byFeed[feed.id]
          cache.byFeed[feed.id] = snap.ok
            ? snap
            : // keep the previous items on failure — the cache must not go blank
              {
                ...(prev ?? { items: [], feedTitle: '' }),
                fetchedAt: snap.fetchedAt,
                ok: false,
                error: snap.error,
              }
        }),
    )
    const ids = new Set(feeds.map((f) => f.id))
    for (const id of Object.keys(cache.byFeed)) {
      if (!ids.has(id)) delete cache.byFeed[id]
    }
    cache.refreshedAt = now()
    // persist feeds too — refresh updates their counts, and a stateRoot move
    // must not depend on a later CRUD write to copy the list across
    await saveFeeds()
    await saveCache()
  }

  /** one refresh at a time; concurrent callers (scheduler + admin button) share the run */
  function refreshNow(): Promise<void> {
    if (!inflight) {
      inflight = doRefresh().finally(() => {
        inflight = null
      })
    }
    return inflight
  }

  function mergedItems(): { refreshedAt: number; items: RssItem[] } {
    // disabled feeds keep their snapshot for a later re-enable, but stop being served
    const enabled = new Set(feeds.filter((f) => f.enabled).map((f) => f.id))
    const items: RssItem[] = []
    for (const [id, snap] of Object.entries(cache.byFeed)) {
      if (enabled.has(id)) items.push(...snap.items)
    }
    items.sort((a, b) => b.publishedAt - a.publishedAt)
    return { refreshedAt: cache.refreshedAt, items: items.slice(0, MAX_ITEMS_TOTAL) }
  }

  const timer = setInterval(() => {
    void refreshNow().catch((err) => console.error('[rss] refresh failed:', err))
  }, options.refreshIntervalMs ?? REFRESH_INTERVAL_MS)
  timer.unref()
  if (options.refreshOnStart !== false) {
    void refreshNow().catch((err) => console.error('[rss] initial refresh failed:', err))
  }
  if (!options.quiet) {
    console.log(
      `[rss] ${feeds.length} feed(s), refreshing every ${(options.refreshIntervalMs ?? REFRESH_INTERVAL_MS) / 60000} min`,
    )
  }

  return {
    registerCloud(app: Hono) {
      app.get('/api/rss/items', (c) => {
        const requested = Number(c.req.query('limit') ?? MAX_ITEMS_TOTAL) || MAX_ITEMS_TOTAL
        const limit = Math.min(Math.max(requested, 1), MAX_ITEMS_TOTAL)
        const { refreshedAt, items } = mergedItems()
        return c.json({ refreshedAt, items: items.slice(0, limit) })
      })
    },
    registerAdmin(app: Hono) {
      app.get('/api/rss/feeds', (c) => {
        const { refreshedAt, items } = mergedItems()
        return c.json({
          refreshedAt,
          total: items.length,
          feeds: feeds.map((f) => {
            const snap = cache.byFeed[f.id]
            return {
              ...f,
              feedTitle: snap?.feedTitle ?? '',
              ok: snap?.ok ?? false,
              count: snap?.items.length ?? 0,
              error: snap?.error ?? '',
              fetchedAt: snap?.fetchedAt ?? 0,
            }
          }),
        })
      })

      app.post('/api/rss/feeds', async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as {
          title?: string
          url?: string
          enabled?: boolean
        }
        const url = (body.url ?? '').trim()
        if (!/^https?:\/\//i.test(url)) {
          return c.json({ error: 'a valid http(s) feed URL is required' }, 400)
        }
        const feed: RssFeed = {
          id: randomUUID(),
          title: (body.title ?? '').trim().slice(0, 128),
          url,
          enabled: body.enabled !== false,
          createdAt: now(),
        }
        feeds.push(feed)
        await saveFeeds()
        return c.json({ ok: true, id: feed.id })
      })

      app.post('/api/rss/feeds/update', async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as {
          id?: string
          title?: string
          url?: string
          enabled?: boolean
        }
        const feed = feeds.find((f) => f.id === (body.id ?? ''))
        if (!feed) return c.json({ error: 'unknown feed' }, 404)
        if (body.url !== undefined) {
          const url = body.url.trim()
          if (!/^https?:\/\//i.test(url)) {
            return c.json({ error: 'a valid http(s) feed URL is required' }, 400)
          }
          feed.url = url
        }
        if (body.title !== undefined) feed.title = body.title.trim().slice(0, 128)
        if (body.enabled !== undefined) feed.enabled = body.enabled
        await saveFeeds()
        return c.json({ ok: true })
      })

      app.post('/api/rss/feeds/delete', async (c) => {
        const body = await c.req.json().catch(() => ({}))
        const id = (body as { id?: string }).id ?? ''
        const index = feeds.findIndex((f) => f.id === id)
        if (index >= 0) feeds.splice(index, 1)
        delete cache.byFeed[id]
        await saveFeeds()
        await saveCache()
        return c.json({ ok: true })
      })

      app.post('/api/rss/refresh', async (c) => {
        try {
          await refreshNow()
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : 'refresh failed' }, 500)
        }
        return c.json({ ok: true, refreshedAt: cache.refreshedAt })
      })
    },
    refreshNow,
    stop() {
      clearInterval(timer)
    },
  }
}
