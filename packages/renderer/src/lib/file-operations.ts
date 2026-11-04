import type { TransferProgress } from "@/types/global"

/** Invalidates work when the user changes folders or starts a newer request. */
export function createRequestTracker() {
  let revision = 0
  return {
    start: () => ++revision,
    isCurrent: (request: number) => request === revision,
    invalidate: () => {
      revision += 1
    },
  }
}

export function selectVisibleKeys(entries: readonly { key: string }[]): Set<string> {
  return new Set(entries.map((entry) => entry.key))
}

export function mergeEntries<T extends { key: string }>(previous: T[], incoming: T[]): T[] {
  return [...new Map([...previous, ...incoming].map((entry) => [entry.key, entry])).values()]
}

/** Events received while the snapshot was loading take precedence over that snapshot. */
export function mergeTransferSnapshots(snapshot: TransferProgress[], current: TransferProgress[]) {
  return [...new Map([...snapshot, ...current].map((item) => [item.id, item])).values()].slice(-50)
}

export function fileOperationError(error: unknown): string {
  const message = String(error)
  if (/target exists|HTTP\s*409|FileAlreadyExists/i.test(message)) {
    return "A file or folder with this name already exists. Rename it or choose another name; nothing was overwritten."
  }
  return message
}

export function isTransferCancelled(error: unknown): boolean {
  return /AbortError|cancelled|operation (?:was )?aborted/i.test(String(error))
}
