import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rendererDir = path.resolve(pkgRoot, '../renderer')
const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173'
const isWin = process.platform === 'win32'

let electronProc = null
let viteProc = null
let restarting = false

function killTree(proc) {
  if (!proc || proc.exitCode !== null) return
  if (isWin) {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { shell: true })
  } else {
    proc.kill('SIGTERM')
  }
}

function shutdown(code = 0) {
  killTree(electronProc)
  killTree(viteProc)
  process.exit(code)
}

function startVite() {
  viteProc = spawn('bun', ['run', 'dev'], {
    cwd: rendererDir,
    stdio: 'inherit',
    shell: isWin,
  })
  viteProc.on('exit', (code) => {
    if (!restarting && code !== null) {
      console.error(`[dev] renderer dev server exited (${code})`)
      shutdown(code || 1)
    }
  })
}

function startElectron() {
  console.log('[dev] launching electron')
  electronProc = spawn(electronPath, ['.'], {
    cwd: pkgRoot,
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: devServerUrl },
  })
  electronProc.on('exit', () => {
    electronProc = null
    if (restarting) {
      restarting = false
      startElectron()
    } else {
      shutdown(0)
    }
  })
}

let restartTimer
// one shared plugin for both contexts; debounce collapses simultaneous rebuilds
const notify = {
  name: 'dev-reload',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) {
        console.error('[dev] build failed:', result.errors)
        return
      }
      clearTimeout(restartTimer)
      restartTimer = setTimeout(() => {
        if (!electronProc) {
          startElectron()
        } else {
          console.log('[dev] restarting electron')
          restarting = true
          killTree(electronProc)
        }
      }, 150)
    })
  },
}

const common = (entry, outfile) => ({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'silent',
  plugins: [notify],
})

const main = await esbuild.context(common('src/main/index.ts', 'dist/main/index.js'))
const preload = await esbuild.context(common('src/preload/index.ts', 'dist/preload/index.js'))

startVite()
await main.watch()
await preload.watch()

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0))
}
process.on('exit', () => {
  killTree(electronProc)
  killTree(viteProc)
})
