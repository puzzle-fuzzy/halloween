import type { BrowserWindow } from 'electron'
import { config } from './config'
import { state } from './state'

let getWin: () => BrowserWindow | null = () => null
let trafficAbort: AbortController | null = null

export function setWindowProvider(getWindow: () => BrowserWindow | null): void {
  getWin = getWindow
}

/** mihomo streams one {"up","down"} json object per second on /traffic —
 * forward each sample to the renderer for the live chart */
export async function startTrafficSampler(): Promise<void> {
  stopTrafficSampler()
  const ac = new AbortController()
  trafficAbort = ac
  try {
    const res = await fetch(`http://127.0.0.1:${state.ctrlPort}/traffic`, {
      headers: { Authorization: `Bearer ${config.secret}` },
      signal: ac.signal,
    })
    if (!res.ok || !res.body) return
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done || ac.signal.aborted) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const s = line.trim()
        if (!s) continue
        try {
          const t = JSON.parse(s) as {
            up: number
            down: number
            upTotal?: number
            downTotal?: number
          }
          getWin()?.webContents.send('proxy:traffic', {
            up: t.up ?? 0,
            down: t.down ?? 0,
            upTotal: t.upTotal ?? 0,
            downTotal: t.downTotal ?? 0,
            ts: Date.now(),
          })
        } catch {
          // partial line — wait for more bytes
        }
      }
    }
  } catch {
    // core stopped — the stream ends by itself
  }
}

export function stopTrafficSampler(): void {
  trafficAbort?.abort()
  trafficAbort = null
}
