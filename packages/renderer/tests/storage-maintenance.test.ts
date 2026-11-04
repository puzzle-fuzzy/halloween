import { describe, expect, test } from "bun:test"
import {
  alternativeRestorePath,
  backupPercent,
  isRestoreConflict,
  mergeBackupJob,
  selectedRecoverable,
  validRestorePath,
} from "../src/lib/storage-maintenance"
import type { BackupJob, BackupStatus, TrashEntry } from "../src/types/global"

describe("trash operations", () => {
  test("conflicting restores suggest a new filename without losing its extension", () => {
    expect(alternativeRestorePath({ originalPath: "/photos/holiday.jpg", type: "file" })).toBe(
      "/photos/holiday (restored).jpg",
    )
    expect(alternativeRestorePath({ originalPath: "/photos/", type: "dir" })).toBe(
      "/photos (restored)",
    )
    expect(alternativeRestorePath({ originalPath: "/.config", type: "file" })).toBe(
      "/.config (restored)",
    )
  })
  test("restore targets cannot escape the cloud drive or enter internal storage", () => {
    expect(validRestorePath("/photos/restored.jpg")).toBe(true)
    for (const path of [
      "relative",
      "/",
      "/../private",
      "/photos/./file",
      "/.halloween-trash/item",
      "/bad\\path",
    ]) {
      expect(validRestorePath(path)).toBe(false)
    }
  })
  test("damaged items remain selectable for deletion but never enter a restore batch", () => {
    const base = { originalPath: "/photo.jpg", deletedAt: 10, type: "file" as const, size: 100 }
    const entries: TrashEntry[] = [
      { ...base, id: "good", recoverable: true },
      { ...base, id: "broken", recoverable: false },
    ]
    expect(
      selectedRecoverable(entries, new Set(["good", "broken"])).map((entry) => entry.id),
    ).toEqual(["good"])
    expect(isRestoreConflict("restore failed: HTTP 409")).toBe(true)
    expect(isRestoreConflict("HTTP 500")).toBe(false)
  })
})

describe("backup task state", () => {
  const job: BackupJob = {
    id: "one",
    kind: "backup",
    status: "running",
    startedAt: 10,
    phase: "backing-up",
  }
  const status: BackupStatus = {
    engine: "restic",
    configured: true,
    available: true,
    jobs: [],
    snapshots: [],
  }
  test("restic fractional progress is displayed as a percentage", () => {
    expect(backupPercent({ ...job, progress: { percent: 0.375 } })).toBe(37.5)
    expect(backupPercent({ ...job, progress: { bytesDone: 20, bytesTotal: 40 } })).toBe(50)
    expect(backupPercent(job)).toBeNull()
  })
  test("a late completed job cannot remove a different active job", () => {
    const newer: BackupJob = { ...job, id: "two", startedAt: 20 }
    const result = mergeBackupJob(
      { ...status, activeJob: newer, jobs: [newer] },
      { ...job, status: "succeeded", finishedAt: 30 },
    )
    expect(result.activeJob?.id).toBe("two")
    expect(result.lastSuccessfulBackup?.id).toBe("one")
  })
  test("a failed task clears its own active slot while retaining the previous successful backup", () => {
    const successful = { ...job, id: "previous", status: "succeeded" as const }
    const result = mergeBackupJob(
      { ...status, activeJob: job, lastSuccessfulBackup: successful },
      { ...job, status: "failed", error: "Repository unavailable" },
    )
    expect(result.activeJob).toBeUndefined()
    expect(result.lastSuccessfulBackup?.id).toBe("previous")
    expect(result.jobs[0]?.status).toBe("failed")
  })
  test("stale running responses and older check results cannot regress completed history", () => {
    const completed = { ...job, status: "succeeded" as const }
    const recorded = { ...status, jobs: [completed] }
    expect(mergeBackupJob(recorded, job)).toBe(recorded)
    const latestCheck: BackupJob = { ...completed, id: "new-check", kind: "check", startedAt: 50 }
    const previousCheck: BackupJob = { ...completed, id: "old-check", kind: "check", startedAt: 20 }
    expect(mergeBackupJob({ ...status, lastCheck: latestCheck }, previousCheck).lastCheck?.id).toBe(
      "new-check",
    )
  })
})
