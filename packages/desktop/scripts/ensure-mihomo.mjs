#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
// Ensures the mihomo core binary for THIS platform exists in resources/
// before a package build. Downloads the pinned release (or MIHOMO_VERSION)
// from GitHub — or MIHOMO_MIRROR (a ghproxy prefix) when GitHub is slow.
//
//   node scripts/ensure-mihomo.mjs [--force] [--platform win32|darwin|linux]
//
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const platformArg = (() => {
  const i = process.argv.indexOf('--platform')
  return i >= 0 ? process.argv[i + 1] : undefined
})()
const platform = platformArg ?? process.platform
const arch = platform === 'win32' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : 'amd64'
const force = process.argv.includes('--force')

const resources = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources')
const targetName = platform === 'win32' ? 'mihomo.exe' : 'mihomo'
const target = path.join(resources, targetName)

if (fs.existsSync(target) && !force) {
  console.log(`[mihomo] ${target} already present`)
  process.exit(0)
}

const version = process.env.MIHOMO_VERSION ?? 'v1.19.33'
const mirror = process.env.MIHOMO_MIRROR?.replace(/\/$/, '')
const asset =
  platform === 'win32'
    ? `mihomo-windows-${arch}-${version}.zip`
    : `mihomo-${platform}-${arch}-${version}.gz`
const urls = [
  ...(mirror
    ? [`${mirror}/https://github.com/MetaCubeX/mihomo/releases/download/${version}/${asset}`]
    : []),
  `https://github.com/MetaCubeX/mihomo/releases/download/${version}/${asset}`,
]

fs.mkdirSync(resources, { recursive: true })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-'))
let archive = null
for (const url of urls) {
  process.stdout.write(`[mihomo] downloading ${url} … `)
  try {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    archive = path.join(tmp, asset)
    fs.writeFileSync(archive, buf)
    console.log(`${(buf.length / 1024 / 1024).toFixed(1)} MB`)
    break
  } catch (err) {
    console.log(`failed (${err.message})`)
  }
}
if (!archive) {
  console.error(`[mihomo] could not download ${asset}
Set MIHOMO_MIRROR to a GitHub proxy prefix, or manually place ${targetName} in
packages/desktop/resources/ — see resources/README.md`)
  process.exit(1)
}

try {
  if (platform === 'win32') {
    // bsdtar/libarchive reads zip on macOS, Windows 10+ and most Linux distros
    execFileSync('tar', ['-xf', archive, '-C', tmp], { stdio: 'inherit' })
    const extracted = fs.readdirSync(tmp).find((f) => f.endsWith('.exe'))
    if (!extracted) throw new Error('no .exe found in the archive')
    fs.renameSync(path.join(tmp, extracted), target)
  } else {
    // macOS/Linux releases are single-file .gz
    const binary = gunzipSync(fs.readFileSync(archive))
    fs.writeFileSync(target, binary)
  }
  fs.chmodSync(target, 0o755)
  console.log(`[mihomo] installed ${target} (${version}, ${platform}-${arch})`)
} catch (err) {
  console.error(`[mihomo] extraction failed: ${err.message}
Extract ${archive} manually and copy the binary to packages/desktop/resources/${targetName}`)
  process.exit(1)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
