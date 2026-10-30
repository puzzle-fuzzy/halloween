import { app, BrowserWindow, ipcMain, shell } from 'electron'
import path from 'node:path'
import { registerCloudHandlers } from './cloud'
import { registerOssHandlers } from './oss'

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
  const win = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
    },
  })

  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  ipcMain.on('window:minimize', () => win.minimize())
  ipcMain.on('window:toggle-maximize', () =>
    win.isMaximized() ? win.unmaximize() : win.maximize()
  )
  ipcMain.on('window:close', () => win.close())
  ipcMain.handle('window:is-maximized', () => win.isMaximized())
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
  registerCloudHandlers(() => mainWindow)
  registerOssHandlers(() => mainWindow)
  void createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})



