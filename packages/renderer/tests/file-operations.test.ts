import { describe, expect, test } from "bun:test"
import { createRequestTracker, fileOperationError, mergeEntries, mergeTransferSnapshots, selectVisibleKeys } from "../src/lib/file-operations"

describe("file browser state", () => {
  test("direct OSS conflict responses explain that existing data was not overwritten", () => {
    for (const error of ["Upload failed: HTTP 409", "FileAlreadyExists", "target exists"]) {
      expect(fileOperationError(error)).toContain("nothing was overwritten")
    }
  })
  test("select all after filtering excludes hidden objects", () => {
    const entries = [{ key: "keep.txt" }, { key: "remove.txt" }]
    const visible = entries.filter((entry) => entry.key.includes("remove"))
    expect([...selectVisibleKeys(visible)]).toEqual(["remove.txt"])
  })

  test("a slow directory response cannot replace a newer search result", () => {
    const requests = createRequestTracker()
    const oldDirectory = requests.start()
    const search = requests.start()
    expect(requests.isCurrent(oldDirectory)).toBe(false)
    expect(requests.isCurrent(search)).toBe(true)
    requests.invalidate()
    expect(requests.isCurrent(search)).toBe(false)
  })

  test("pagination deduplicates directory prefixes across pages", () => {
    expect(mergeEntries([{ key: "photos/" }], [{ key: "photos/" }, { key: "video.mp4" }]))
      .toEqual([{ key: "photos/" }, { key: "video.mp4" }])
  })

  test("a stale progress snapshot cannot hide a failure event", () => {
    const base = { id: "upload-1", kind: "upload" as const, name: "photo.jpg", loaded: 50, total: 100 }
    const items = mergeTransferSnapshots(
      [{ ...base, status: "running" }],
      [{ ...base, status: "failed", error: "Connection interrupted" }],
    )
    expect(items[0]?.status).toBe("failed")
    expect(items[0]?.error).toBe("Connection interrupted")
  })
})
