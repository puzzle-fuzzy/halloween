import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { XMLParser } from 'fast-xml-parser'

export interface RssFeed {
  id: string
  /** display name; empty = use the title advertised by the feed itself */
  title: string
  url: string
  enabled: boolean
  createdAt: number
}

export interface RssItem {
  id: string
  feedId: string
  feedTitle: string
  title: string
  link: string
  publishedAt: number
  summary: string
}

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

let stateRoot = ''
let legacyRoot = ''
let feeds: RssFeed[] = []
let cache: RssCache = { refreshedAt: 0, byFeed: {} }
let inflight: Promise<void> | null = null

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' })

function feedsFile(root: string = stateRoot): string {
  return path.join(root, '.rss-feeds.json')
}

function cacheFile(root: string = stateRoot): string {
  return path.join(root, '.rss-cache.json')
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8'))
  } catch {
    return undefined
  }
}

async function loadState(): Promise<void> {
  // prefer stateRoot, fall back to the pre-split location in dataRoot once
  let raw = (await readJson(feedsFile())) as { feeds?: RssFeed[] } | undefined
  if (!raw && legacyRoot) raw = (await readJson(feedsFile(legacyRoot))) as { feeds?: RssFeed[] } | undefined
  feeds = (raw?.feeds ?? []).map((f) => ({ ...f, enabled: f.enabled !== false }))
  let cached = (await readJson(cacheFile())) as Partial<RssCache> | undefined
  if (!cached && legacyRoot) cached = (await readJson(cacheFile(legacyRoot))) as Partial<RssCache> | undefined
  cache = { refreshedAt: cached?.refreshedAt ?? 0, byFeed: cached?.byFeed ?? {} }
}

async function saveFeeds(): Promise<void> {
  await fs.writeFile(feedsFile(), JSON.stringify({ feeds }, null, 2), 'utf-8')
}

async function saveCache(): Promise<void> {
  await fs.writeFile(cacheFile(), JSON.stringify(cache), 'utf-8')
}

// ------------------------------------------------------------- xml parsing

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}

/** xml values come back as string | number | { '#text': … } | arrays of those */
function textOf(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return textOf(v[0])
  if (typeof v === 'object') return textOf((v as Record<string, unknown>)['#text'])
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

  const channel = (doc['rss'] as Record<string, unknown> | undefined)?.['channel'] as
    | Record<string, unknown>
    | undefined
  if (channel) {
    return {
      feedTitle: stripHtml(textOf(channel['title'])),
      items: asArray(channel['item']).map((raw): RawItem => {
        const it = raw as Record<string, unknown>
        const link = textOf(it['link'])
        return {
          key: textOf(it['guid']) || link,
          title: stripHtml(textOf(it['title'])) || link,
          link,
          publishedAt: parseTime(textOf(it['pubDate'])) || parseTime(textOf(it['dc:date'])),
          summary: stripHtml(textOf(it['description'])),
        }
      }),
    }
  }

  const atom = doc['feed'] as Record<string, unknown> | undefined
  if (atom) {
    return {
      feedTitle: stripHtml(textOf(atom['title'])),
      items: asArray(atom['entry']).map((raw): RawItem => {
        const it = raw as Record<string, unknown>
        const link = atomLink(it['link'])
        return {
          key: textOf(it['id']) || link,
          title: stripHtml(textOf(it['title'])) || link,
          link,
          publishedAt: parseTime(textOf(it['published'])) || parseTime(textOf(it['updated'])),
          summary: stripHtml(textOf(it['summary']) || textOf(it['content'])),
        }
      }),
    }
  }

  const rdf = doc['rdf:RDF'] as Record<string, unknown> | undefined
  if (rdf) {
    const channelTitle = (rdf['channel'] as Record<string, unknown> | undefined)?.['title']
    return {
      feedTitle: stripHtml(textOf(channelTitle)),
      items: asArray(rdf['item']).map((raw): RawItem => {
        const it = raw as Record<string, unknown>
        const link = textOf(it['link'])
        return {
          key: link, // rdf items have no guid — the link is the stable key
          title: stripHtml(textOf(it['title'])) || link,
          link,
          publishedAt: parseTime(textOf(it['dc:date'])) || parseTime(textOf(it['date'])),
          summary: stripHtml(textOf(it['description'])),
        }
      }),
    }
  }

  throw new Error('unsupported feed format (expected RSS 2.0, Atom or RDF)')
}

// ----------------------------------------------------------------- refresh

async function fetchFeed(feed: RssFeed): Promise<FeedSnapshot> {
  const fetchedAt = Date.now()
  try {
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': 'halloween-rss/1.0' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    })
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
            { ...(prev ?? { items: [], feedTitle: '' }), fetchedAt: snap.fetchedAt, ok: false, error: snap.error }
      })
  )
  const ids = new Set(feeds.map((f) => f.id))
  for (const id of Object.keys(cache.byFeed)) {
    if (!ids.has(id)) delete cache.byFeed[id]
  }
  cache.refreshedAt = Date.now()
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

// ------------------------------------------------------------------ export

export async function initRss(options: { dataRoot: string; stateRoot?: string }): Promise<void> {
  // rss feeds/cache are server-private state — they belong in stateRoot, not
  // the user-visible cloud data root; legacyRoot enables a one-time migration
  stateRoot = options.stateRoot ?? options.dataRoot
  legacyRoot = options.stateRoot ? options.dataRoot : ''
  await loadState()
  console.log(`[rss] ${feeds.length} feed(s), refreshing every ${REFRESH_INTERVAL_MS / 60000} min`)
  void refreshNow().catch((err) => console.error('[rss] initial refresh failed:', err))
  setInterval(() => {
    void refreshNow().catch((err) => console.error('[rss] refresh failed:', err))
  }, REFRESH_INTERVAL_MS)
}

/** client endpoint on the cloud app — serves the server-side cache, never fetches live */
export function registerRssCloud(app: Hono): void {
  app.get('/api/rss/items', (c) => {
    const requested = Number(c.req.query('limit') ?? MAX_ITEMS_TOTAL) || MAX_ITEMS_TOTAL
    const limit = Math.min(Math.max(requested, 1), MAX_ITEMS_TOTAL)
    const { refreshedAt, items } = mergedItems()
    return c.json({ refreshedAt, items: items.slice(0, limit) })
  })
}

/** admin feed management; auth comes from the admin app's /api/* middleware */
export function registerRssAdmin(app: Hono): void {
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
      createdAt: Date.now(),
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
    feeds = feeds.filter((f) => f.id !== id)
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
}
