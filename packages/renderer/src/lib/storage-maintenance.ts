import type { BackupJob, BackupStatus, TrashEntry } from "@/types/global"

export function trashName(entry: Pick<TrashEntry, "originalPath" | "id">): string {
  return (
    entry.originalPath?.split("/").filter(Boolean).at(-1) ||
    `Unidentified item ${entry.id.slice(0, 8)}`
  )
}

export function alternativeRestorePath(entry: Pick<TrashEntry, "originalPath" | "type">): string {
  if (!entry.originalPath) return "/restored-item"
  const parts = entry.originalPath.replace(/\/$/, "").split("/")
  const name = parts.pop() || "restored-item"
  const dot = entry.type === "file" ? name.lastIndexOf(".") : -1
  const next = dot > 0 ? `${name.slice(0, dot)} (restored)${name.slice(dot)}` : `${name} (restored)`
  return [...parts, next].join("/")
}

export function validRestorePath(path: string): boolean {
  return (
    path.startsWith("/") &&
    path.length > 1 &&
    !/[\\\0]/.test(path) &&
    !path.split("/").some((part) => part.startsWith("."))
  )
}

export function isRestoreConflict(error: unknown): boolean {
  return /HTTP\s*409|target exists|FileAlreadyExists/i.test(String(error))
}

export function selectedRecoverable(entries: TrashEntry[], selected: Set<string>): TrashEntry[] {
  return entries.filter((entry) => selected.has(entry.id) && entry.recoverable)
}

/** A late result from an older task cannot hide a different task that is still running. */
export function mergeBackupJob(status: BackupStatus, job: BackupJob): BackupStatus {
  const existing = status.jobs.find((item) => item.id === job.id)
  if (existing && existing.status !== "running" && job.status === "running") return status
  const terminal = job.status !== "running"
  const isLatest = (previous?: BackupJob) => !previous || job.startedAt >= previous.startedAt
  const jobs = [...status.jobs.filter((item) => item.id !== job.id), job]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 20)
  return {
    ...status,
    jobs,
    activeJob:
      status.activeJob && status.activeJob.id !== job.id
        ? status.activeJob
        : terminal
          ? undefined
          : job,
    lastSuccessfulBackup:
      job.kind === "backup" && job.status === "succeeded" && isLatest(status.lastSuccessfulBackup)
        ? job
        : status.lastSuccessfulBackup,
    lastCheck:
      job.kind === "check" && terminal && isLatest(status.lastCheck) ? job : status.lastCheck,
    lastVerification:
      job.kind === "verify" && terminal && isLatest(status.lastVerification)
        ? job
        : status.lastVerification,
  }
}

export function backupPercent(job: BackupJob): number | null {
  const progress = job.progress
  if (!progress) return null
  const fraction =
    typeof progress.percent === "number" && Number.isFinite(progress.percent)
      ? progress.percent
      : progress.bytesTotal && typeof progress.bytesDone === "number"
        ? progress.bytesDone / progress.bytesTotal
        : progress.filesTotal && typeof progress.filesDone === "number"
          ? progress.filesDone / progress.filesTotal
          : null
  return fraction === null ? null : Math.min(100, Math.max(0, fraction * 100))
}
