import { app, BrowserWindow, ipcMain, shell } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerCloudHandlers } from './cloud'
import { registerOssHandlers } from './oss'
import { registerProxyHandlers, shutdownProxy } from './proxy/index'
import { registerRssHandlers } from './rss'

const devServerUrl = process.env['VITE_DEV_SERVER_URL']

let mainWindow: BrowserWindow | null = null

app.setName('Halloween')

async function waitForDevServer(url: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(url)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
}

async function createWindow(): Promise<void> {
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // windows/linux: frameless shell with in-app caption buttons;
    // mac: keep the native traffic lights over a hidden-inset title bar
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const } : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  })

  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  const sendMaximizeState = () =>
    win.webContents.send('window:maximize-changed', win.isMaximized())
  win.on('maximize', sendMaximizeState)
  win.on('unmaximize', sendMaximizeState)

  win.on('ready-to-show', () => win.show())

  win.webContents.on('console-message', (event) => {
    console.log(`[renderer] ${event.message}`)
  })
  win.webContents.on('did-finish-load', () => console.log('[main] page loaded'))

  win.webContents.on('render-process-gone', (_event, details) =>
    console.error(`[main] renderer gone: ${details.reason}`)
  )

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const entryUrl = devServerUrl || pathToFileURL(path.join(__dirname, '../renderer/index.html')).toString()
  const isAppUrl = (url: string): boolean => {
    const candidate = new URL(url)
    const entry = new URL(entryUrl)
    return devServerUrl ? candidate.origin === entry.origin : candidate.protocol === 'file:' && candidate.pathname === entry.pathname
  }
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })
  win.webContents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())

  win.webContents.on(
    'did-fail-load',
    (_event, code, description, url) => console.error(`[main] load failed: ${code} ${description} ${url}`)
  )

  if (devServerUrl) {
    await waitForDevServer(devServerUrl)
    await win.loadURL(devServerUrl)
  } else {
    await win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(() => {
  // These belong to the application lifetime, including when macOS recreates its window.
  ipcMain.on('window:minimize', () => mainWindow?.minimize())
  ipcMain.on('window:toggle-maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize()
    else mainWindow?.maximize()
  })
  ipcMain.on('window:close', () => mainWindow?.close())
  ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false)
  registerCloudHandlers(() => mainWindow)
  registerOssHandlers(() => mainWindow)
  registerRssHandlers()
  registerProxyHandlers(() => mainWindow)
  void createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// kill the core and clear the system proxy — a dead 127.0.0.1 proxy breaks
// the machine's networking, so this must run before exit
app.on('will-quit', () => {
  shutdownProxy()
})



