import * as React from "react"
import { Link } from "react-router-dom"
import { IconArchive, IconCheck, IconRefresh, IconShieldCheck } from "@tabler/icons-react"
import { toast } from "sonner"

import { useCloudAuth } from "@/components/cloud/auth"
import { useI18n } from "@/i18n"
import { Badge } from "@halloween/ui/badge"
import { Button } from "@halloween/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@halloween/ui/card"
import { Label } from "@halloween/ui/label"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@halloween/ui/table"
import { createRequestTracker } from "@/lib/file-operations"
import { formatBytes, formatTime } from "@/lib/format"
import { backupPercent, mergeBackupJob } from "@/lib/storage-maintenance"
import type { BackupJob, BackupJobKind, BackupStatus } from "@/types/global"



import type { Dict } from "@/i18n"

function JobBadge({ job, t }: { job: BackupJob; t: Dict }) {
  return <Badge variant={job.status === "failed" || job.status === "interrupted" ? "destructive" : "outline"}>{job.status === "succeeded" ? t.backups.jobSucceeded : job.status === "running" ? t.backups.jobRunning : job.status === "interrupted" ? t.backups.jobInterrupted : t.backups.jobFailed}</Badge>
}
function LastRun({ label, job, t }: { label: string; job?: BackupJob; t: Dict }) {
  return <Card><CardHeader><CardDescription>{label}</CardDescription><CardTitle className="text-lg">{job ? formatTime(job.finishedAt ?? job.startedAt) : t.common.never}</CardTitle></CardHeader><CardContent className="space-y-2">{job ? <><JobBadge job={job} t={t} />{job.error && <p className="text-destructive break-words text-xs">{job.error}</p>}</> : <p className="text-muted-foreground text-xs">{t.backups.noRuns}</p>}</CardContent></Card>
}

export default function BackupsPage() {
  const auth = useCloudAuth()
  const { t } = useI18n()
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
          if (job.status === "succeeded") toast.success(t.backups.taskCompleted(t.backups.taskLabels[job.kind]))
          else toast.error(job.error || t.backups.taskStatus(t.backups.taskLabels[job.kind], job.status))
          return
        }
        setStatus((current) => current ? mergeBackupJob(current, job) : current)
      } catch (e) {
        if (!active) return
        consecutiveFailures += 1
        handleError(e)
        if (consecutiveFailures >= 3) {
          setPollError(t.backups.livePaused(String(e)))
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
    <p>{auth.error || (auth.authed === null ? t.common.checkingConnection : t.backups.signInTitle)}</p>
    {auth.authed === null && auth.error ? <Button variant="outline" onClick={() => void auth.retry()}>{t.common.retryConnection}</Button> : auth.authed === false && <Button asChild><Link to="/cloud">{t.common.signInCloud}</Link></Button>}
  </div>

  const disabled = loading || starting || !status?.configured || !status.available || Boolean(status.activeJob)
  const active = status?.activeJob
  const percent = active ? backupPercent(active) : null
  return <div className="flex flex-1 flex-col gap-5 p-4 lg:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">{t.backups.title}</h2><p className="text-muted-foreground mt-1 text-sm">{t.backups.subtitle}</p></div><Button variant="outline" size="sm" disabled={loading || starting} onClick={() => void load()}><IconRefresh />{t.backups.refreshStatus}</Button></div>
    {error && <div role="alert" className="rounded-lg border p-3 text-sm text-destructive break-words">{error}</div>}
    {!status ? <p className="text-muted-foreground text-sm">{loading ? t.backups.loadingStatus : t.backups.statusFailed}</p> : <>
      <Card><CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle>{t.backups.service}</CardTitle><Badge variant={status.configured && status.available ? "outline" : "secondary"}>{!status.configured ? t.backups.notConfigured : status.available ? t.backups.available : t.backups.unavailable}</Badge></div><CardDescription>{status.configured && status.available ? t.backups.readyDesc : status.reason || t.backups.needsAttention}</CardDescription></CardHeader><CardContent className="space-y-2 text-sm">
        {status.version && <p className="text-muted-foreground">{t.backups.engine(status.version)}</p>}
        {!status.configured && <p>{t.backups.configureHint}</p>}
        {status.configured && !status.available && <p>{t.backups.checkEngineHint}</p>}
      </CardContent></Card>
      <div className="grid gap-3 md:grid-cols-3"><LastRun label={t.backups.lastBackup} job={status.lastSuccessfulBackup} t={t} /><LastRun label={t.backups.lastCheck} job={status.lastCheck} t={t} /><LastRun label={t.backups.lastVerify} job={status.lastVerification} t={t} /></div>
      <Card><CardHeader><CardTitle>{t.backups.runTask}</CardTitle><CardDescription>{t.backups.runTaskDesc}</CardDescription></CardHeader><CardContent className="flex flex-wrap gap-2"><Button disabled={disabled} onClick={() => void start("backup")}><IconArchive />{t.backups.createNow}</Button><Button variant="outline" disabled={disabled} onClick={() => void start("check")}><IconCheck />{t.backups.checkIntegrity}</Button><Button variant="outline" disabled={disabled} onClick={() => void start("refresh")}><IconRefresh />{t.backups.refreshSnapshots}</Button></CardContent></Card>
      {active && <Card><CardHeader><div className="flex flex-wrap items-center justify-between gap-2"><CardTitle className="text-base">{t.backups.taskLabels[active.kind]}</CardTitle><JobBadge job={active} t={t} /></div><CardDescription>{t.backups.phases[active.phase] || active.phase}</CardDescription></CardHeader><CardContent className="space-y-3" aria-live="polite">
        <Progress value={percent ?? undefined} aria-label={t.backups.progressAria} />
        <p className="text-muted-foreground text-sm">{percent === null ? t.backups.working : `${Math.round(percent)}%`}{active.progress?.filesDone !== undefined && ` · ${t.backups.filesUnit(active.progress.filesDone, active.progress.filesTotal)}`}{active.progress?.bytesDone !== undefined && ` · ${active.progress.bytesDone === 0 ? "0 B" : formatBytes(active.progress.bytesDone)}${active.progress.bytesTotal ? ` / ${formatBytes(active.progress.bytesTotal)}` : ""}`}</p>
        <p className="text-muted-foreground text-xs">{t.backups.startedAt(formatTime(active.startedAt))}</p>
      </CardContent></Card>}
      {pollError && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm"><p className="text-destructive flex-1 break-words">{pollError}</p><Button variant="outline" size="sm" onClick={() => { setMonitorAttempt((value) => value + 1); void load() }}>{t.common.retryUpdates}</Button></div>}
      <Card><CardHeader><CardTitle>{t.backups.verifyTitle}</CardTitle><CardDescription>{t.backups.verifyDesc}</CardDescription></CardHeader><CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm">{t.backups.snapshotListCached}</p>
        <div className="flex flex-wrap items-end gap-3"><div className="min-w-0 flex-1 space-y-2"><Label htmlFor="backup-snapshot">{t.backups.snapshot}</Label><Select value={snapshotId} onValueChange={setSnapshotId} disabled={disabled || !status.snapshots.length}><SelectTrigger id="backup-snapshot" className="w-full"><SelectValue placeholder={t.backups.noSnapshots} /></SelectTrigger><SelectContent>{status.snapshots.map((snapshot) => <SelectItem key={snapshot.id} value={snapshot.id}>{formatTime(snapshot.createdAt)} · {snapshot.id.slice(0, 12)}</SelectItem>)}</SelectContent></Select></div><Button disabled={disabled || !snapshotId} onClick={() => void start("verify")}><IconShieldCheck />{t.backups.verifyRestore}</Button></div>
        {status.snapshots.length > 0 && <div className="max-h-64 overflow-auto rounded-md border"><Table><TableHeader><TableRow><TableHead>{t.backups.created}</TableHead><TableHead>{t.backups.snapshot}</TableHead><TableHead>{t.backups.filesCol}</TableHead><TableHead>{t.common.size}</TableHead></TableRow></TableHeader><TableBody>{status.snapshots.map((snapshot) => <TableRow key={snapshot.id}><TableCell className="whitespace-nowrap">{formatTime(snapshot.createdAt)}</TableCell><TableCell className="font-mono text-xs" title={snapshot.id}>{snapshot.id.slice(0, 12)}</TableCell><TableCell>{snapshot.files ?? "—"}</TableCell><TableCell>{snapshot.bytes === undefined ? "—" : snapshot.bytes === 0 ? "0 B" : formatBytes(snapshot.bytes)}</TableCell></TableRow>)}</TableBody></Table></div>}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>{t.backups.recentTasks}</CardTitle><CardDescription>{t.backups.recentTasksDesc}</CardDescription></CardHeader><CardContent>{status.jobs.length === 0 ? <p className="text-muted-foreground text-sm">{t.backups.noTasks}</p> : <div className="overflow-auto"><Table><TableHeader><TableRow><TableHead>{t.backups.task}</TableHead><TableHead>{t.backups.created}</TableHead><TableHead>{t.backups.result}</TableHead><TableHead>{t.backups.details}</TableHead></TableRow></TableHeader><TableBody>{status.jobs.map((job) => <TableRow key={job.id}><TableCell className="whitespace-nowrap">{t.backups.taskLabels[job.kind]}</TableCell><TableCell className="whitespace-nowrap">{formatTime(job.startedAt)}</TableCell><TableCell><JobBadge job={job} t={t} /></TableCell><TableCell className="max-w-md break-words text-sm">{job.error ? <span className="text-destructive">{job.error}</span> : job.result ? `${job.result.files === undefined ? "" : t.backups.nFiles(job.result.files)}${job.result.bytes === undefined ? "" : ` · ${job.result.bytes === 0 ? "0 B" : formatBytes(job.result.bytes)}`}` || t.backups.phases[job.phase] || job.phase : t.backups.phases[job.phase] || job.phase}</TableCell></TableRow>)}</TableBody></Table></div>}</CardContent></Card>
    </>}
  </div>
}
