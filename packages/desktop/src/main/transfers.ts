import { randomUUID } from 'node:crypto'

export interface TransferProgress {
  id: string
  kind: 'upload' | 'download'
  name: string
  loaded: number
  total: number
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  error?: string
}

export class TransferRegistry {
  private entries = new Map<string, TransferProgress>()
  private lastEmitted = new Map<string, number>()
  private controllers = new Map<string, AbortController>()
  notify: (progress: TransferProgress) => void = () => {}
  constructor(private historyLimit = 100) {}
  list(): TransferProgress[] { return [...this.entries.values()].map((value) => ({ ...value })) }
  start(kind: TransferProgress['kind'], name: string, total = 0): string {
    const id = randomUUID()
    this.controllers.set(id, new AbortController())
    this.publish({ id, kind, name, loaded: 0, total, status: 'running' }, true)
    return id
  }
  progress(id: string, loaded: number, total?: number): void {
    const entry = this.entries.get(id)
    if (entry?.status === 'running') this.publish({ ...entry, loaded, total: total ?? entry.total })
  }
  complete(id: string): void {
    const entry = this.entries.get(id)
    if (entry?.status === 'running') {
      this.controllers.delete(id)
      this.publish({ ...entry, status: 'completed', total: entry.loaded }, true)
    }
  }
  fail(id: string, error: unknown): void {
    const entry = this.entries.get(id)
    if (entry?.status === 'running') {
      this.controllers.delete(id)
      this.publish({ ...entry, status: 'failed', error: error instanceof Error ? error.message : String(error) }, true)
    }
  }
  signal(id: string): AbortSignal | undefined { return this.controllers.get(id)?.signal }
  cancel(id: string): void {
    const entry = this.entries.get(id)
    if (entry?.status !== 'running') return
    this.controllers.get(id)?.abort(new DOMException('Transfer cancelled', 'AbortError'))
    this.controllers.delete(id)
    this.publish({ ...entry, status: 'cancelled' }, true)
  }
  private publish(entry: TransferProgress, force = false): void {
    this.entries.set(entry.id, entry)
    const now = Date.now()
    if (force || now - (this.lastEmitted.get(entry.id) ?? 0) >= 250) {
      this.lastEmitted.set(entry.id, now)
      this.notify({ ...entry })
    }
    const finished = [...this.entries.values()].filter((value) => value.status !== 'running')
    for (const value of finished.slice(0, Math.max(0, finished.length - this.historyLimit))) {
      this.entries.delete(value.id)
      this.lastEmitted.delete(value.id)
    }
  }
}

export const transfers = new TransferRegistry()
