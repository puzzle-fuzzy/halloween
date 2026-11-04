import type { BrowserWindow } from 'electron'
import { app, net as electronNet, ipcMain, shell } from 'electron'

const REPO = 'puzzle-fuzzy/halloween'
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`

export interface UpdateCheckResult {
  current: string
  latest: string | null
  /** null = unknown (private repo or network failure), boolean = definitive */
  available: boolean | null
  reason?: 'private-repo' | 'network'
}

let getWin: () => BrowserWindow | null = () => null

function normalize(version: string): string {
  return version.replace(/^v/, '')
}

/**
 * Anonymous check against the GitHub latest-release API. The repository is
 * private, so a 404 is the expected answer until it goes public or a token
 * strategy is chosen — in that case we say "unknown" and point at the
 * releases page instead of pretending there is no update.
 */
async function fetchLatest(): Promise<string | null> {
  const res = await electronNet.fetch(API_URL, {
    headers: { 'User-Agent': 'halloween-desktop', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(10_000),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const tag = ((await res.json()) as { tag_name?: string }).tag_name
  return tag ? normalize(tag) : null
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const current = app.getVersion()
  try {
    const latest = await fetchLatest()
    if (latest === null) return { current, latest: null, available: null, reason: 'private-repo' }
    return { current, latest, available: latest !== current }
  } catch {
    return { current, latest: null, available: null, reason: 'network' }
  }
}

export function registerUpdaterHandlers(getWindow: () => BrowserWindow | null): void {
  getWin = getWindow
  ipcMain.handle('update:check', () => checkForUpdates())
  ipcMain.handle('update:open-releases', () => {
    void shell.openExternal(RELEASES_URL)
  })
  // silent startup check — surface a newer release without user action
  void checkForUpdates().then((result) => {
    if (result.available) getWin()?.webContents.send('update:available', result)
  })
}
