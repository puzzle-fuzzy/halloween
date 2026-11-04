#!/usr/bin/env node
// Ensures resources/mihomo.exe exists before a Windows package build.
// Downloads the pinned mihomo release (or MIHOMO_VERSION) from GitHub —
// or from MIHOMO_MIRROR (e.g. a ghproxy prefix) when GitHub is slow.
//
//   node scripts/ensure-mihomo.mjs [--force]
//
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const resources = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources')
const target = path.join(resources, 'mihomo.exe')
const force = process.argv.includes('--force')

if (fs.existsSync(target) && !force) {
  console.log(`[mihomo] ${target} already present`)
  process.exit(0)
}

const version = process.env.MIHOMO_VERSION ?? 'v1.19.13'
const mirror = process.env.MIHOMO_MIRROR?.replace(/\/$/, '') // e.g. https://ghfast.top/https://github.com
const asset = `mihomo-windows-amd64-${version}.zip`
const urls = [
  ...(mirror
    ? [`${mirror}/https://github.com/MetaCubeX/mihomo/releases/download/${version}/${asset}`]
    : []),
  `https://github.com/MetaCubeX/mihomo/releases/download/${version}/${asset}`,
]

fs.mkdirSync(resources, { recursive: true })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-'))
let zip = null
for (const url of urls) {
  process.stdout.write(`[mihomo] downloading ${url} … `)
  try {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    zip = path.join(tmp, asset)
    fs.writeFileSync(zip, buf)
    console.log(`${(buf.length / 1024 / 1024).toFixed(1)} MB`)
    break
  } catch (err) {
    console.log(`failed (${err.message})`)
  }
}
if (!zip) {
  console.error(`[mihomo] could not download ${asset}
Set MIHOMO_MIRROR to a GitHub proxy prefix, or manually place mihomo.exe in
packages/desktop/resources/ — see resources/README.md`)
  process.exit(1)
}

try {
  // bsdtar/libarchive reads zip on macOS, Windows 10+ and most Linux distros
  execFileSync('tar', ['-xf', zip, '-C', tmp], { stdio: 'inherit' })
  const extracted = fs.readdirSync(tmp).find((f) => f.endsWith('.exe'))
  if (!extracted) throw new Error('no .exe found in the archive')
  fs.renameSync(path.join(tmp, extracted), target)
  fs.chmodSync(target, 0o755)
  console.log(`[mihomo] installed ${target} (${version})`)
} catch (err) {
  console.error(`[mihomo] extraction failed: ${err.message}
Extract ${zip} manually and copy the contained .exe to packages/desktop/resources/mihomo.exe`)
  process.exit(1)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
