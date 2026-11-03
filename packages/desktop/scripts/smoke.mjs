import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mainFile = process.argv.includes('--packaged')
  ? path.join(root, 'release/mac-arm64/Halloween.app/Contents/Resources/app.asar/dist/main/index.js')
  : path.join(root, 'dist/main/index.js')
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'halloween-electron-smoke-'))
const entry = path.join(temporary, 'smoke.cjs')
await fs.writeFile(entry, `
const {app, BrowserWindow} = require('electron');
const assert = require('node:assert/strict');
app.setPath('userData', ${JSON.stringify(path.join(temporary, 'user-data'))});
app.disableHardwareAcceleration();
process.on('unhandledRejection', error => { console.error(error); app.exit(1); });
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
const loaded = win => new Promise((resolve, reject) => {
  win.webContents.once('did-finish-load', resolve);
  win.webContents.once('did-fail-load', (_event, code, message) => reject(new Error(message + ': ' + code)));
});
require(${JSON.stringify(mainFile)});
app.whenReady().then(async () => {
  const first = BrowserWindow.getAllWindows()[0];
  assert(first, 'first window exists');
  await loaded(first);
  assert.equal(await first.webContents.executeJavaScript('typeof window.electron.cloud.transfers'), 'function');
  assert.equal(await first.webContents.executeJavaScript('typeof window.electron.oss.objects'), 'function');
  for (const method of ['listTrash','restoreTrash','purgeTrash','backupStatus','startBackupJob','backupJob']) {
    assert.equal(await first.webContents.executeJavaScript('typeof window.electron.cloud.' + method), 'function');
  }
  await assert.rejects(first.webContents.executeJavaScript('window.electron.cloud.listTrash()'), /not configured|Sign in/i);
  await assert.rejects(first.webContents.executeJavaScript('window.electron.cloud.backupStatus()'), /not configured|Sign in/i);
  assert.equal(await first.webContents.executeJavaScript('typeof require'), 'undefined');
  assert.equal(await first.webContents.executeJavaScript('window.electron.cloud.isAuthed()'), false);
  assert.equal(await first.webContents.executeJavaScript('window.electron.window.isMaximized()'), false);
  app.removeAllListeners('window-all-closed');
  const closed = new Promise(resolve => first.once('closed', resolve));
  first.close();
  await closed;
  app.emit('activate');
  const second = BrowserWindow.getAllWindows()[0];
  assert(second && second !== first, 'window recreated after close');
  await loaded(second);
  assert.equal(await second.webContents.executeJavaScript('window.electron.window.isMaximized()'), false);
  assert(Array.isArray(await second.webContents.executeJavaScript('window.electron.cloud.transfers()')));
  console.log('PASS: page/preload, isolated credentials, recovery IPC/auth gates, close and activate, transfers snapshot');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
setTimeout(() => { console.error('Smoke test timed out'); app.exit(1); }, 25000);
`)
try {
  const executable = require('electron')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.VITE_DEV_SERVER_URL
  const code = await new Promise((resolve, reject) => {
    const child = spawn(executable, [entry], { cwd: root, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
  process.exitCode = code
} finally {
  await fs.rm(temporary, { recursive: true, force: true })
}
