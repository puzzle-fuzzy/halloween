export interface TrashEntry {
  id: string
  originalPath: string | null
  deletedAt: number | null
  type: 'file' | 'dir' | 'unknown'
  size: number
  recoverable: boolean
  error?: string
}

export interface TrashListing {
  entries: TrashEntry[]
  totalBytes: number
  incomplete: boolean
}

export interface TrashPurgeInput {
  ids?: string[]
  all?: boolean
  confirmation: 'DELETE' | 'EMPTY_TRASH'
}

export type BackupJobKind = 'backup' | 'check' | 'verify' | 'refresh'
export interface BackupJob {
  id: string
  kind: BackupJobKind
  status: 'running' | 'succeeded' | 'failed' | 'interrupted'
  startedAt: number
  finishedAt?: number
  phase: string
  snapshotId?: string
  progress?: { filesDone?: number; filesTotal?: number; bytesDone?: number; bytesTotal?: number; percent?: number }
  result?: { files?: number; bytes?: number; manifestSha256?: string; restoreId?: string }
  error?: string
}
export interface BackupSnapshot {
  id: string
  createdAt: number
  files?: number
  bytes?: number
}
export interface BackupStatus {
  engine: 'restic'
  configured: boolean
  available: boolean
  reason?: string
  version?: string
  activeJob?: BackupJob
  jobs: BackupJob[]
  snapshots: BackupSnapshot[]
  lastSuccessfulBackup?: BackupJob
  lastCheck?: BackupJob
  lastVerification?: BackupJob
}

export interface TrashRestoreResult { ok: true; path: string; warning?: string }
export interface TrashPurgeResult { ok: boolean; purged: number; failed?: { id: string; error: string }[] }
export interface BackupStartInput { kind: BackupJobKind; snapshotId?: string }
