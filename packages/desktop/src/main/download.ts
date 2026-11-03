import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

interface DownloadOptions {
  url: string
  headers?: Record<string, string>
  targetDir: string
  name: string
  onProgress: (loaded: number, total: number) => void
  request?: (url: string, init?: RequestInit) => Promise<Response>
  signal?: AbortSignal
  /** Allows regression checks for filesystems without hard links. */
  publication?: { link: typeof fsp.link; copyFile: typeof fsp.copyFile }
}

/** Complete the temporary file before publishing it under a unique final name. */
export async function downloadFile({ url, headers, targetDir, name, onProgress, request = fetch, signal, publication = fsp }: DownloadOptions): Promise<string> {
  if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) throw new Error('Invalid download filename')
  const response = await request(url, { headers, signal })
  if (!response.ok || !response.body) throw new Error(`Download failed for ${name}: HTTP ${response.status}`)
  const temporary = path.join(targetDir, `.halloween-${randomUUID()}.part`)
  const total = Number(response.headers.get('content-length') ?? 0)
  let loaded = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      loaded += chunk.length
      onProgress(loaded, total)
      callback(null, chunk)
    },
  })
  try {
    await pipeline(
      Readable.fromWeb(response.body as never),
      counter,
      fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
      { signal },
    )
    if (total > 0 && !response.headers.get('content-encoding') && loaded !== total) throw new Error(`Download incomplete: expected ${total} bytes, received ${loaded}`)
    const ext = path.extname(name)
    const base = path.basename(name, ext)
    for (let index = 0; ; index++) {
      const target = path.join(targetDir, index ? `${base} (${index})${ext}` : name)
      let ownsTarget = false
      try {
        signal?.throwIfAborted()
        try {
          await publication.link(temporary, target)
          ownsTarget = true
        } catch (error) {
          if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
          // Reserve the name exclusively so any failed copy can safely remove its own partial output.
          const reservation = await fsp.open(target, 'wx', 0o600)
          ownsTarget = true
          await reservation.close()
          await publication.copyFile(temporary, target)
        }
        signal?.throwIfAborted()
        onProgress(loaded, loaded)
        return target
      } catch (error) {
        if (ownsTarget) await fsp.rm(target, { force: true })
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
  } finally {
    await fsp.rm(temporary, { force: true })
  }
}
