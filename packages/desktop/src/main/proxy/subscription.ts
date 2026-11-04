import { net as electronNet } from 'electron'
import type { ClashProxy } from '../proxy-parse'
import { parseSubscriptionBody, uniqueNames } from '../proxy-parse'
import { config, saveConfig } from './config'

const FETCH_TIMEOUT_MS = 15_000

/** airports pick the payload by client UA; some reject unknown ones with 403 */
const SUB_USER_AGENTS = [
  'clash-verge/2.5.8',
  'clash.meta/1.19.0',
  'ClashforWindows/0.20.39',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
]

export async function fetchSubscription(url: string): Promise<ClashProxy[]> {
  let lastError: Error | null = null
  for (const ua of SUB_USER_AGENTS) {
    try {
      // net.fetch = chromium network stack: browser TLS fingerprint, so
      // cloudflare-fronted subscription hosts don't reject us as a bot
      const res = await electronNet.fetch(url, {
        headers: { 'User-Agent': ua, Accept: '*/*' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
      })
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).trim().slice(0, 120)
        lastError = new Error(`HTTP ${res.status}${body ? ` — ${body}` : ''}`)
        if (res.status === 403 || res.status === 406 || res.status === 429) continue
        throw lastError
      }
      const proxies = parseSubscriptionBody(await res.text())
      if (proxies.length === 0) {
        // e.g. an html error page served with 200 — try the next identity
        lastError = new Error('no nodes found in subscription')
        continue
      }
      return proxies
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }
  throw lastError ?? new Error('subscription fetch failed')
}

/** fetch every subscription (fallback to its cache), merge into one node list */
export async function collectProxies(): Promise<ClashProxy[]> {
  const merged: ClashProxy[] = []
  let failures = 0
  for (const sub of config.subscriptions) {
    try {
      const nodes = await fetchSubscription(sub.url)
      sub.nodeCount = nodes.length
      sub.updatedAt = Date.now()
      config.subNodes[sub.id] = nodes
      merged.push(...nodes)
    } catch (err) {
      failures++
      console.error(
        `[proxy] subscription "${sub.name}" failed:`,
        err instanceof Error ? err.message : err,
      )
      const cached = config.subNodes[sub.id]
      if (cached?.length) merged.push(...(cached as ClashProxy[]))
    }
  }
  if (merged.length === 0) {
    throw new Error(
      config.subscriptions.length === 0
        ? 'no subscription configured'
        : 'all subscriptions failed to fetch',
    )
  }
  if (failures > 0) console.warn(`[proxy] ${failures} subscription(s) served from cache`)
  await saveConfig()
  return uniqueNames(merged)
}
