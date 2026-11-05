import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { createApplication } from "../packages/server/src/index"

const root = path.resolve(import.meta.dir, "..")
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "halloween-proxy-smoke-"))
let server: ReturnType<typeof Bun.serve> | undefined
let vite: ReturnType<typeof Bun.spawn> | undefined
try {
  const adminPassword = "proxy-fixture-password-123"
  const app = await createApplication({
    dataRoot: path.join(temporary, "files"),
    stateRoot: path.join(temporary, "state"),
    token: "proxy-fixture-token-".repeat(3),
    adminPassword,
    quiet: true,
    publicOrigin: "http://127.0.0.1:3690",
  })
  server = Bun.serve({ hostname: "127.0.0.1", port: 3690, fetch: app.fetch })
  const require = createRequire(path.join(root, "packages/admin/package.json"))
  const viteEntry = path.join(path.dirname(require.resolve("vite/package.json")), "bin/vite.js")
  vite = Bun.spawn([process.execPath, viteEntry, "--host", "127.0.0.1"], {
    cwd: path.join(root, "packages/admin"),
    stdout: "pipe",
    stderr: "pipe",
  })
  let ready = false
  for (let i = 0; i < 200; i++) {
    if (vite.exitCode !== null) {
      const detail =
        vite.stderr instanceof ReadableStream
          ? await new Response(vite.stderr).text()
          : String(vite.exitCode)
      throw new Error(`Vite exited: ${detail}`)
    }
    const response = await fetch("http://127.0.0.1:5174/admin/", {
      signal: AbortSignal.timeout(1500),
    }).catch(() => null)
    if (response?.ok) {
      ready = true
      break
    }
    await Bun.sleep(100)
  }
  assert(ready, "local Vite server must start on port 5174")
  const login = (origin: string) =>
    fetch("http://127.0.0.1:5174/admin/api/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ password: adminPassword }),
    })
  assert.equal(
    (await login("http://127.0.0.1:5174")).status,
    200,
    "local admin UI passes origin checks through the dev proxy",
  )
  assert.equal(
    (await login("https://untrusted.invalid")).status,
    403,
    "untrusted origins are not rewritten as trusted",
  )
  console.log(
    "PASS: real Vite proxy permits the local admin UI and preserves cross-origin rejection",
  )
} finally {
  if (vite) {
    vite.kill()
    await vite.exited
  }
  server?.stop(true)
  await fs.rm(temporary, { recursive: true, force: true })
}
