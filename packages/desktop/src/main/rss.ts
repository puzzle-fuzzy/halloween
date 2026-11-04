import type { RssItem } from '@halloween/contracts/rss'
import { ipcMain, shell } from 'electron'
import { apiJson } from './cloud'

export type { RssItem }

/** RSS items are served from the server-side cache — the desktop only reads */
export function registerRssHandlers(): void {
  ipcMain.handle('rss:items', (_e, limit?: number) =>
    apiJson<{ refreshedAt: number; items: RssItem[] }>(
      `/api/rss/items?limit=${Math.max(1, Math.min(limit ?? 100, 300))}`,
    ),
  )

  ipcMain.handle('rss:open', async (_e, url: string) => {
    // window.open only forwards https: out of the renderer — feeds may link http
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })
}
