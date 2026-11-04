import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

// Test tooling only: never initializes a repository or installs a system binary.
const VERSION = "0.19.1"
const RELEASE = `https://github.com/restic/restic/releases/download/v${VERSION}`
const MAX_ARCHIVE = 64 * 1024 * 1024
const MAX_BINARY = 128 * 1024 * 1024
const CHILD_ENV = { PATH: process.env.PATH ?? "", LANG: "C" }

function platformAsset(): string {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error(`unsupported platform: ${process.platform}; use darwin or linux`)
  const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : undefined
  if (!arch) throw new Error(`unsupported architecture: ${process.arch}; use x64 or arm64`)
  return `restic_${VERSION}_${process.platform}_${arch}.bz2`
}

async function responseFor(asset: string): Promise<Response> {
  let response: Response
  try {
    response = await fetch(`${RELEASE}/${asset}`, {
      signal: AbortSignal.timeout(120_000),
      redirect: "follow",
    })
  } catch {
    throw new Error(`could not download official ${asset} (network error or timeout)`)
  }
  if (!response.ok)
    throw new Error(`official ${asset} download failed with HTTP ${response.status}`)
  if (new URL(response.url).protocol !== "https:" || !response.body)
    throw new Error(`invalid official ${asset} response`)
  return response
}

function declaredSize(response: Response, maximum: number): void {
  const value = response.headers.get("Content-Length")
  if (value === null) return
  const bytes = Number(value)
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > maximum)
    throw new Error("download declares an invalid or excessive size")
}

async function checksums(): Promise<string> {
  const response = await responseFor("SHA256SUMS")
  declaredSize(response, 256 * 1024)
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of response.body!) {
    bytes += chunk.length
    if (bytes > 256 * 1024) throw new Error("official SHA256SUMS is unexpectedly large")
    chunks.push(chunk)
  }
  if (!bytes) throw new Error("official SHA256SUMS is empty")
  return Buffer.concat(chunks).toString("utf8")
}

function expectedChecksum(sums: string, asset: string): string {
  const matches: string[] = []
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})[ \t]+\*?(.+)$/.exec(line)
    if (match?.[2] === asset) matches.push(match[1]!.toLowerCase())
  }
  if (matches.length !== 1)
    throw new Error(`official SHA256SUMS must contain exactly one entry for ${asset}`)
  return matches[0]!
}

async function download(asset: string, target: string): Promise<void> {
  const response = await responseFor(asset)
  declaredSize(response, MAX_ARCHIVE)
  const handle = await fs.open(target, "wx", 0o600)
  let bytes = 0
  try {
    for await (const chunk of response.body!) {
      bytes += chunk.length
      if (bytes > MAX_ARCHIVE)
        throw new Error("restic archive exceeds the 64 MiB test-download limit")
      await handle.writeFile(chunk)
    }
    if (bytes < 1024 * 1024) throw new Error("restic archive is unexpectedly small")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function checksum(file: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

async function decompress(bzip2: string, archive: string, output: string): Promise<void> {
  const child = spawn(bzip2, ["-d", "-c", archive], {
    shell: false,
    env: CHILD_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let bytes = 0,
    timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, 30_000)
  const done = new Promise<number>((resolve, reject) => {
    child.once("error", () => reject(new Error("bzip2 could not start")))
    child.once("close", (code) => resolve(code ?? 1))
  })
  // Drain diagnostics without mixing any output into the executable-path stdout.
  child.stderr.on("data", () => {})
  const limited = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length
      callback(
        bytes > MAX_BINARY ? new Error("expanded restic binary exceeds the 128 MiB limit") : null,
        chunk,
      )
    },
  })
  const copied = pipeline(
    child.stdout,
    limited,
    createWriteStream(output, { flags: "wx", mode: 0o700 }),
  )
  try {
    const [, code] = await Promise.all([copied, done])
    if (timedOut) throw new Error("bzip2 decompression timed out")
    if (code !== 0) throw new Error(`bzip2 decompression failed (exit ${code})`)
    if (bytes < 1024 * 1024) throw new Error("expanded restic binary is unexpectedly small")
  } catch (error) {
    child.kill("SIGKILL")
    await Promise.allSettled([copied, done])
    throw error
  } finally {
    clearTimeout(timer)
  }
  await fs.chmod(output, 0o700)
}

async function verifyVersion(binary: string): Promise<void> {
  const child = spawn(binary, ["version"], {
    shell: false,
    env: CHILD_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = "",
    invalidSize = false,
    timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, 10_000)
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    if (output.length + chunk.length > 4096) {
      invalidSize = true
      child.kill("SIGKILL")
    } else output += chunk
  })
  child.stderr.on("data", () => {})
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", () => reject(new Error("verified restic executable could not start")))
      child.once("close", (value) => resolve(value ?? 1))
    })
    if (timedOut || invalidSize || code !== 0 || !/^restic 0\.19\.1(?:\s|$)/.test(output.trim()))
      throw new Error("verified executable did not report restic 0.19.1")
  } finally {
    clearTimeout(timer)
  }
}

let directory: string | undefined
try {
  const asset = platformAsset()
  const bzip2 = Bun.which("bzip2")
  if (!bzip2)
    throw new Error(
      "bzip2 is required but was not found on PATH; install it before running this test helper",
    )
  directory = await fs.mkdtemp(path.join(os.tmpdir(), `halloween-restic-${VERSION}-`))
  await fs.chmod(directory, 0o700)
  const expected = expectedChecksum(await checksums(), asset)
  const archive = path.join(directory, asset),
    binary = path.join(directory, "restic")
  await download(asset, archive)
  if ((await checksum(archive)) !== expected)
    throw new Error("official restic archive SHA-256 mismatch; refusing to execute it")
  await decompress(bzip2, archive, binary)
  await verifyVersion(binary)
  await fs.unlink(archive)
  process.stderr.write(
    `Verified official restic ${VERSION} for ${process.platform}/${process.arch}; remove its temporary directory after testing.\n`,
  )
  process.stdout.write(`${path.resolve(binary)}\n`)
} catch (error) {
  if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
  process.stderr.write(
    `fetch-test-restic: ${error instanceof Error ? error.message : "download failed"}\n`,
  )
  process.exitCode = 1
}
