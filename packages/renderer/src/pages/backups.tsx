import * as React from "react"
import { Link } from "react-router-dom"
import { IconArchive, IconCheck, IconRefresh, IconShieldCheck } from "@tabler/icons-react"
import { toast } from "sonner"

import { useCloudAuth } from "@/components/cloud/auth"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { createRequestTracker } from "@/lib/file-operations"
import { formatBytes, formatTime } from "@/lib/format"
import { backupPercent, mergeBackupJob } from "@/lib/storage-maintenance"
import type { BackupJob, BackupJobKind, BackupStatus } from "@/types/global"

const JOB_LABELS: Record<BackupJobKind, string> = { backup: "Create backup", check: "Integrity check", verify: "Restore verification", refresh: "Refresh snapshots" }
const PHASE_LABELS: Record<string, string> = {
  starting: "Starting", snapshotting: "Preparing a consistent snapshot", hashing: "Building the file manifest", "backing-up": "Backing up files",
  "listing-snapshots": "Loading snapshots", "checking-all-data": "Checking all repository data", restoring: "Restoring to an isolated workspace",
  "verifying-manifest": "Verifying restored files", completed: "Completed", failed: "Failed", interrupted: "Interrupted",
}

function JobBadge({ job }: { job: BackupJob }) {
  return <Badge variant={job.status === "failed" || job.status === "interrupted" ? "destructive" : "outline"}>{job.status === "succeeded" ? "Succeeded" : job.status === "running" ? "Running" : job.status === "interrupted" ? "Interrupted" : "Failed"}</Badge>
}
function LastRun({ label, job }: { label: string; job?: BackupJob }) {
  return <Card><CardHeader><CardDescription>{label}</CardDescription><CardTitle className="text-lg">{job ? formatTime(job.finishedAt ?? job.startedAt) : "Never"}</CardTitle></CardHeader><CardContent className="space-y-2">{job ? <><JobBadge job={job} />{job.error && <p className="text-destructive break-words text-xs">{job.error}</p>}</> : <p className="text-muted-foreground text-xs">No completed run recorded.</p>}</CardContent></Card>
}

export default function BackupsPage() {
  const auth = useCloudAuth()
  const handleError = auth.handleError
  const cloud = window.electron?.cloud
  const [status, setStatus] = React.useState<BackupStatus | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [starting, setStarting] = React.useState(false)
  const [error, setError] = React.useState("")
  const [pollError, setPollError] = React.useState("")
  const [monitorAttempt, setMonitorAttempt] = React.useState(0)
  const [snapshotId, setSnapshotId] = React.useState("")
  const mounted = React.useRef(false)
  const lifecycle = React.useRef(0)
  const requests = React.useRef(createRequestTracker()).current

  const load = React.useCallback(async () => {
    if (!cloud) return
    const request = requests.start()
    setLoading(true)
    setError("")
    try {
      const next = await cloud.backupStatus()
      if (mounted.current && requests.isCurrent(request)) setStatus(next)
    } catch (e) {
      if (mounted.current && requests.isCurrent(request)) { setError(String(e)); handleError(e) }
    } finally {
      if (mounted.current && requests.isCurrent(request)) setLoading(false)
    }
  }, [cloud, requests, handleError])

  React.useEffect(() => {
    mounted.current = true
    lifecycle.current += 1
    setStarting(false)
    if (auth.authed) void load()
    else { setStatus(null); setPollError("") }
    return () => { mounted.current = false; lifecycle.current += 1; requests.invalidate() }
  }, [auth.authed, load, requests])

  const activeJobId = status?.activeJob?.id
  React.useEffect(() => {
    if (!cloud || !auth.authed || !activeJobId) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let consecutiveFailures = 0
    setPollError("")
    const poll = async () => {
      try {
        const job = await cloud.backupJob(activeJobId)
        if (!active) return
        consecutiveFailures = 0
        setPollError("")
        if (job.status !== "running") {
          let next: BackupStatus | null = null
          try { next = await cloud.backupStatus() }
          catch (e) { if (active) { setPollError(String(e)); handleError(e) } }
          if (!active) return
          setStatus((current) => next ?? (current ? mergeBackupJob(current, job) : current))
          if (job.status === "succeeded") toast.success(`${JOB_LABELS[job.kind]} completed`)
          else toast.error(job.error || `${JOB_LABELS[job.kind]} ${job.status}`)
          return
        }
        setStatus((current) => current ? mergeBackupJob(current, job) : current)
      } catch (e) {
        if (!active) return
        consecutiveFailures += 1
        handleError(e)
        if (consecutiveFailures >= 3) {
          setPollError(`Live updates paused. The job may still be running on the server. ${String(e)}`)
          return
        }
      }
      if (active) timer = setTimeout(() => void poll(), 1000)
    }
    void poll()
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [cloud, auth.authed, activeJobId, monitorAttempt, handleError])

  React.useEffect(() => {
    const snapshots = status?.snapshots ?? []
    if (!snapshots.some((snapshot) => snapshot.id === snapshotId)) setSnapshotId(snapshots[0]?.id ?? "")
  }, [status?.snapshots, snapshotId])

  const start = async (kind: BackupJobKind) => {
    if (!cloud || !status?.configured || !status.available || status.activeJob || loading || starting) return
    if (kind === "verify" && !status.snapshots.some((snapshot) => snapshot.id === snapshotId)) return
    const operation = lifecycle.current
    const current = () => mounted.current && lifecycle.current === operation
    requests.invalidate()
    setStarting(true)
    setError("")
    setPollError("")
    try {
      const job = await cloud.startBackupJob({ kind, ...(kind === "verify" ? { snapshotId } : {}) })
      if (!current()) return
      setStatus((current) => current ? mergeBackupJob(current, job) : current)
    } catch (e) {
      if (current()) { setError(String(e)); handleError(e) }
    } finally {
      if (current()) setStarting(false)
    }
  }

  if (!auth.authed) return <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm">
    <p>{auth.error || (auth.authed === null ? "Checking your connection…" : "Sign in to manage backups.")}</p>
    {auth.authed === null && auth.error ? <Button variant="outline" onClick={() => void auth.retry()}>Retry connection</Button> : auth.authed === false && <Button asChild><Link to="/cloud">Sign in to cloud drive</Link></Button>}
  </div>

  const disabled = loading || starting || !status?.configured || !status.available || Boolean(status.activeJob)
  const active = status?.activeJob
  const percent = active ? backupPercent(active) : null
  return <div className="flex flex-1 flex-col gap-5 p-4 lg:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">Backups</h2><p className="text-muted-foreground mt-1 text-sm">Create backups, check their integrity, and verify a restore.</p></div><Button variant="outline" size="sm" disabled={loading || starting} onClick={() => void load()}><IconRefresh />Refresh status</Button></div>
    {error && <div role="alert" className="rounded-lg border p-3 text-sm text-destructive break-words">{error}</div>}
    {!status ? <p className="text-muted-foreground text-sm">{loading ? "Loading backup status…" : "Backup status could not be loaded. Refresh status to try again."}</p> : <>
      <Card><CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle>Backup service</CardTitle><Badge variant={status.configured && status.available ? "outline" : "secondary"}>{!status.configured ? "Not configured" : status.available ? "Available" : "Unavailable"}</Badge></div><CardDescription>{status.configured && status.available ? "Your server is ready to use its dedicated backup repository." : status.reason || "The backup service needs attention on your server."}</CardDescription></CardHeader><CardContent className="space-y-2 text-sm">
        {status.version && <p className="text-muted-foreground">Backup engine: {status.version}</p>}
        {!status.configured && <p>Configure a dedicated backup repository, its password file, and restic on your server, then refresh status. Credentials stay on the server.</p>}
        {status.configured && !status.available && <p>Check the backup engine and repository settings on your server, then refresh status.</p>}
      </CardContent></Card>
      <div className="grid gap-3 md:grid-cols-3"><LastRun label="Last successful backup" job={status.lastSuccessfulBackup} /><LastRun label="Last integrity check" job={status.lastCheck} /><LastRun label="Last restore verification" job={status.lastVerification} /></div>
      <Card><CardHeader><CardTitle>Run a backup task</CardTitle><CardDescription>Tasks continue on the server if you leave this page. Only one task can run at a time.</CardDescription></CardHeader><CardContent className="flex flex-wrap gap-2"><Button disabled={disabled} onClick={() => void start("backup")}><IconArchive />Create backup now</Button><Button variant="outline" disabled={disabled} onClick={() => void start("check")}><IconCheck />Check repository integrity</Button><Button variant="outline" disabled={disabled} onClick={() => void start("refresh")}><IconRefresh />Refresh snapshots</Button></CardContent></Card>
      {active && <Card><CardHeader><div className="flex flex-wrap items-center justify-between gap-2"><CardTitle className="text-base">{JOB_LABELS[active.kind]}</CardTitle><JobBadge job={active} /></div><CardDescription>{PHASE_LABELS[active.phase] || active.phase}</CardDescription></CardHeader><CardContent className="space-y-3" aria-live="polite">
        <Progress value={percent ?? undefined} aria-label="Backup task progress" />
        <p className="text-muted-foreground text-sm">{percent === null ? "Working…" : `${Math.round(percent)}%`}{active.progress?.filesDone !== undefined && ` · ${active.progress.filesDone}${active.progress.filesTotal !== undefined ? ` / ${active.progress.filesTotal}` : ""} files`}{active.progress?.bytesDone !== undefined && ` · ${active.progress.bytesDone === 0 ? "0 B" : formatBytes(active.progress.bytesDone)}${active.progress.bytesTotal ? ` / ${formatBytes(active.progress.bytesTotal)}` : ""}`}</p>
        <p className="text-muted-foreground text-xs">Started {formatTime(active.startedAt)}</p>
      </CardContent></Card>}
      {pollError && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm"><p className="text-destructive flex-1 break-words">{pollError}</p><Button variant="outline" size="sm" onClick={() => { setMonitorAttempt((value) => value + 1); void load() }}>Retry updates</Button></div>}
      <Card><CardHeader><CardTitle>Verify a restore</CardTitle><CardDescription>Restores the selected snapshot into an isolated workspace and compares its files with the saved manifest.</CardDescription></CardHeader><CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm">The snapshot list is cached. Use Refresh snapshots to fetch the latest list from the repository.</p>
        <div className="flex flex-wrap items-end gap-3"><div className="min-w-0 flex-1 space-y-2"><Label htmlFor="backup-snapshot">Snapshot</Label><Select value={snapshotId} onValueChange={setSnapshotId} disabled={disabled || !status.snapshots.length}><SelectTrigger id="backup-snapshot" className="w-full"><SelectValue placeholder="No snapshots available" /></SelectTrigger><SelectContent>{status.snapshots.map((snapshot) => <SelectItem key={snapshot.id} value={snapshot.id}>{formatTime(snapshot.createdAt)} · {snapshot.id.slice(0, 12)}</SelectItem>)}</SelectContent></Select></div><Button disabled={disabled || !snapshotId} onClick={() => void start("verify")}><IconShieldCheck />Verify restore</Button></div>
        {status.snapshots.length > 0 && <div className="max-h-64 overflow-auto rounded-md border"><Table><TableHeader><TableRow><TableHead>Created</TableHead><TableHead>Snapshot</TableHead><TableHead>Files</TableHead><TableHead>Size</TableHead></TableRow></TableHeader><TableBody>{status.snapshots.map((snapshot) => <TableRow key={snapshot.id}><TableCell className="whitespace-nowrap">{formatTime(snapshot.createdAt)}</TableCell><TableCell className="font-mono text-xs" title={snapshot.id}>{snapshot.id.slice(0, 12)}</TableCell><TableCell>{snapshot.files ?? "—"}</TableCell><TableCell>{snapshot.bytes === undefined ? "—" : snapshot.bytes === 0 ? "0 B" : formatBytes(snapshot.bytes)}</TableCell></TableRow>)}</TableBody></Table></div>}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Recent tasks</CardTitle><CardDescription>Recent results recorded by this server.</CardDescription></CardHeader><CardContent>{status.jobs.length === 0 ? <p className="text-muted-foreground text-sm">No backup tasks recorded yet.</p> : <div className="overflow-auto"><Table><TableHeader><TableRow><TableHead>Task</TableHead><TableHead>Started</TableHead><TableHead>Result</TableHead><TableHead>Details</TableHead></TableRow></TableHeader><TableBody>{status.jobs.map((job) => <TableRow key={job.id}><TableCell className="whitespace-nowrap">{JOB_LABELS[job.kind]}</TableCell><TableCell className="whitespace-nowrap">{formatTime(job.startedAt)}</TableCell><TableCell><JobBadge job={job} /></TableCell><TableCell className="max-w-md break-words text-sm">{job.error ? <span className="text-destructive">{job.error}</span> : job.result ? `${job.result.files === undefined ? "" : `${job.result.files} files`}${job.result.bytes === undefined ? "" : ` · ${job.result.bytes === 0 ? "0 B" : formatBytes(job.result.bytes)}`}` || PHASE_LABELS[job.phase] || job.phase : PHASE_LABELS[job.phase] || job.phase}</TableCell></TableRow>)}</TableBody></Table></div>}</CardContent></Card>
    </>}
  </div>
}
