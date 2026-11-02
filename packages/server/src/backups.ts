import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { atomicJson, HTTPError, readJson } from './storage'

import type { BackupJobKind, BackupJob, BackupSnapshot, BackupStatus } from '@halloween/contracts'
export type { BackupJobKind, BackupJob, BackupSnapshot, BackupStatus } from '@halloween/contracts'
export interface BackupConfig {
  repository?: string; passwordFile?: string; binary?: string; backendEnv?: NodeJS.ProcessEnv
}
export interface ResticRequest {
  binary: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number
  onJson?: (value: Record<string, unknown>) => void
}
export interface ResticResult { code: number; stdout: string }
export type ResticRunner = (request: ResticRequest) => Promise<ResticResult>
const TAG = 'halloween-personal-cloud-v1'
const ID = /^[a-f0-9]{64}$/
const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const CONTROL_FILES = ['tokens.json', 'profile.json', 'oss-accounts.json', 'trash']

/** No application master token/password or arbitrary RESTIC_PASSWORD_COMMAND reaches the child. */
export function backupConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BackupConfig {
  const backendEnv: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (/^(AWS_|AZURE_|B2_|GOOGLE_|OS_|ST_|RCLONE_CONFIG_)/.test(key) ||
      ['RESTIC_REST_USERNAME', 'RESTIC_REST_PASSWORD', 'RESTIC_CACERT', 'RESTIC_TLS_CLIENT_CERT', 'SSH_AUTH_SOCK', 'HOME', 'PATH', 'LANG', 'TMPDIR'].includes(key)) backendEnv[key] = value
  }
  return { repository: env.BACKUP_REPOSITORY, passwordFile: env.BACKUP_PASSWORD_FILE, binary: env.BACKUP_RESTIC_BINARY, backendEnv }
}

/** bounded diagnostic capture; stderr is deliberately never returned or logged (may contain credentials). */
export const spawnRestic: ResticRunner = (request) => new Promise((resolve, reject) => {
  const child = spawn(request.binary, request.args, { cwd: request.cwd, env: request.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', pending = '', overflow = false, timedOut = false
  const timer = request.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, request.timeoutMs) : undefined
  const stop = () => { if (timer) clearTimeout(timer) }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    if (stdout.length + chunk.length > 8 * 1024 * 1024) {
      // Progress lines do not need retaining. Keep only the last bounded window.
      stdout = stdout.slice(-4 * 1024 * 1024)
      overflow = true
    }
    stdout += chunk
    pending += chunk
    if (pending.length > 2 * 1024 * 1024) { pending = ''; return }
    let newline: number
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
      try { request.onJson?.(JSON.parse(line)) } catch { /* restic also emits plain text on older releases */ }
    }
  })
  child.stderr.on('data', () => {})
  child.once('error', (error: NodeJS.ErrnoException) => { stop(); reject(Object.assign(new Error(error.code === 'ENOENT' ? 'restic executable is unavailable' : 'restic could not start'), { code: error.code })) })
  child.once('close', (code) => {
    stop()
    if (timedOut) return reject(new Error('restic command timed out'))
    if (overflow && request.args.includes('snapshots')) return reject(new Error('Snapshot list is too large; use a dedicated repository'))
    resolve({ code: code ?? 1, stdout })
  })
})

function inside(candidate: string, root: string) { return candidate === root || candidate.startsWith(root + path.sep) }
function overlaps(a: string, b: string) { return inside(a, b) || inside(b, a) }
async function regularFile(filename: string) {
  const stat = await fs.lstat(filename)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a regular file')
  return stat
}
async function digestFile(filename: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of fss.createReadStream(filename)) digest.update(chunk)
  return digest.digest('hex')
}

/** Stable links are safe because application writes publish new inodes; no source is modified here. */
export async function snapshotTree(source: string, target: string, link: typeof fs.link = fs.link): Promise<void> {
  const stat = await fs.lstat(source)
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('Backup sources contain a symbolic link or unsupported special file')
  if (stat.isDirectory()) {
    await fs.mkdir(target, { mode: 0o700 })
    for (const name of (await fs.readdir(source)).sort()) await snapshotTree(path.join(source, name), path.join(target, name), link)
    await fs.chmod(target, stat.mode & 0o777)
    await fs.utimes(target, stat.atime, stat.mtime)
  } else {
    try { await link(source, target) }
    catch (error) {
      if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      await fs.copyFile(source, target, fss.constants.COPYFILE_EXCL)
      await fs.chmod(target, stat.mode & 0o777)
      await fs.utimes(target, stat.atime, stat.mtime)
    }
  }
}

interface ManifestSummary { files: number; bytes: number; manifestSha256: string }
async function manifest(root: string, output?: string): Promise<ManifestSummary> {
  const digest = createHash('sha256')
  let files = 0, bytes = 0
  const handle = output ? await fs.open(output, 'wx', 0o600) : undefined
  const walk = async (directory: string, rel: string): Promise<void> => {
    for (const name of (await fs.readdir(directory)).sort()) {
      if (!rel && name === 'manifest.jsonl') continue
      const local = path.join(directory, name), p = rel ? `${rel}/${name}` : name
      const stat = await fs.lstat(local)
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Snapshot contains unsupported entries')
      const row = stat.isDirectory() ? { p, type: 'dir', mode: stat.mode & 0o777 } : { p, type: 'file', mode: stat.mode & 0o777, size: stat.size, sha256: await digestFile(local) }
      const line = JSON.stringify(row) + '\n'
      digest.update(line)
      if (handle) await handle.writeFile(line)
      if (stat.isDirectory()) await walk(local, p)
      else { files++; bytes += stat.size }
    }
  }
  try { await walk(root, ''); await handle?.sync() }
  finally { await handle?.close() }
  return { files, bytes, manifestSha256: digest.digest('hex') }
}

interface SavedState {
  version: 1; repositoryFingerprint: string; jobs: BackupJob[]; snapshots: BackupSnapshot[]
  lastSuccessfulBackup?: BackupJob; lastCheck?: BackupJob; lastVerification?: BackupJob
}
function parseState(value: unknown): SavedState {
  const state = value as SavedState
  if (!state || state.version !== 1 || typeof state.repositoryFingerprint !== 'string' || !Array.isArray(state.jobs) || !Array.isArray(state.snapshots)) throw new Error('invalid backup state')
  for (const job of [...state.jobs, state.lastSuccessfulBackup, state.lastCheck, state.lastVerification].filter((value): value is BackupJob => value !== undefined)) if (!job || !JOB_ID.test(job.id) || !['backup', 'check', 'verify', 'refresh'].includes(job.kind) || !['running', 'succeeded', 'failed', 'interrupted'].includes(job.status) || !Number.isFinite(job.startedAt) || typeof job.phase !== 'string') throw new Error('invalid backup job')
  for (const snapshot of state.snapshots) if (!snapshot || !ID.test(snapshot.id) || !Number.isFinite(snapshot.createdAt)) throw new Error('invalid backup snapshot')
  if (new Set(state.jobs.map((job) => job.id)).size !== state.jobs.length ||
    (state.lastSuccessfulBackup && (state.lastSuccessfulBackup.kind !== 'backup' || state.lastSuccessfulBackup.status !== 'succeeded')) ||
    (state.lastCheck && (state.lastCheck.kind !== 'check' || state.lastCheck.status === 'running')) ||
    (state.lastVerification && (state.lastVerification.kind !== 'verify' || state.lastVerification.status === 'running'))) throw new Error('invalid backup result summary')
  return state
}

function disabledManager(reason: string) {
  return {
    status: (): BackupStatus => ({ engine: 'restic', configured: false, available: false, reason, jobs: [], snapshots: [] }),
    start: async (_input: { kind: BackupJobKind; snapshotId?: string }): Promise<BackupJob> => { throw new HTTPError(503, reason) },
    job: (_id: string): BackupJob => { throw new HTTPError(404, 'Backup history is unavailable until its metadata is repaired') },
    waitForIdle: () => Promise.resolve(),
  }
}

export async function createBackupManager(options: {
  dataRoot: string; stateRoot: string
  withSnapshot: <T>(work: () => Promise<T>) => Promise<T>
  config?: BackupConfig; runner?: ResticRunner
  /** Test-only filesystem injection; production defaults to link then copy across volumes. */
  link?: typeof fs.link
}) {
  const dataRoot = await fs.realpath(options.dataRoot), stateRoot = await fs.realpath(options.stateRoot)
  const config = options.config ?? backupConfigFromEnv(), runner = options.runner ?? spawnRestic
  const binary = config.binary || 'restic'
  const controlRoot = path.join(stateRoot, 'backups'), workRoot = path.join(controlRoot, 'work'), restoreRoot = path.join(controlRoot, 'restores')
  try {
    for (const directory of [controlRoot, workRoot, restoreRoot]) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      if ((await fs.lstat(directory)).isSymbolicLink() || await fs.realpath(directory) !== directory) throw new Error('Backup working directories must not be symbolic links')
      await fs.chmod(directory, 0o700)
    }
  } catch {
    return disabledManager('The private backup workspace is unavailable or unsafe. Repair its server permissions and remove symbolic links before enabling backups.')
  }
  const stateFile = path.join(controlRoot, 'jobs.json')
  const fingerprint = createHash('sha256').update(config.repository ?? '').digest('hex')
  let saved: SavedState
  try {
    saved = await readJson<SavedState>(stateFile, parseState, { version: 1, repositoryFingerprint: fingerprint, jobs: [], snapshots: [] })
  } catch {
    // Backup history must never take the primary cloud/trash service offline or overwrite evidence.
    return disabledManager('Backup metadata cannot be read or is invalid. It has been preserved; restore a valid backup history file before enabling backup jobs.')
  }
  // A changed repository cannot inherit another repository's success or restoration claims.
  const jobs = saved.repositoryFingerprint === fingerprint ? saved.jobs.slice(0, 30) : []
  let snapshots = saved.repositoryFingerprint === fingerprint ? saved.snapshots.slice(0, 500) : []
  let lastSuccessfulBackup = saved.repositoryFingerprint === fingerprint ? saved.lastSuccessfulBackup ?? jobs.find((job) => job.kind === 'backup' && job.status === 'succeeded') : undefined
  let lastCheck = saved.repositoryFingerprint === fingerprint ? saved.lastCheck ?? jobs.find((job) => job.kind === 'check' && job.status !== 'running') : undefined
  let lastVerification = saved.repositoryFingerprint === fingerprint ? saved.lastVerification ?? jobs.find((job) => job.kind === 'verify' && job.status !== 'running') : undefined
  for (const job of jobs) if (job.status === 'running') {
    job.status = 'interrupted'; job.finishedAt = Date.now(); job.phase = 'interrupted'; job.error = 'The service restarted before the job finished. Refresh the repository before retrying.'
  }
  try {
    // Work contains only generated UUID staging trees; stale trees are safe to discard after a restart.
    for (const entry of await fs.readdir(workRoot)) if (JOB_ID.test(entry)) await fs.rm(path.join(workRoot, entry), { recursive: true, force: true })
    // Verification never keeps a second complete copy; remove payloads from interrupted/older jobs.
    for (const entry of await fs.readdir(restoreRoot)) if (JOB_ID.test(entry)) {
      const directory = path.join(restoreRoot, entry), stat = await fs.lstat(directory)
      if (stat.isSymbolicLink() || !stat.isDirectory()) await fs.rm(directory, { recursive: true, force: true })
      else if (!jobs.some((job) => job.id === entry)) await fs.rm(directory, { recursive: true, force: true })
      else await fs.rm(path.join(directory, 'content'), { recursive: true, force: true })
    }
  } catch {
    return disabledManager('Interrupted backup workspace cleanup failed. Repair its server permissions before enabling backup jobs.')
  }
  let available = false, version: string | undefined, reason: string | undefined, active: Promise<void> | undefined
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ...config.backendEnv, RESTIC_REPOSITORY: config.repository, RESTIC_PASSWORD_FILE: config.passwordFile, RESTIC_CACHE_DIR: path.join(controlRoot, 'cache') }
  // Password commands/options inherited from an unrelated restic setup are never honored.
  delete env.RESTIC_PASSWORD; delete env.RESTIC_PASSWORD_COMMAND; delete env.RESTIC_REPOSITORY_FILE
  async function persist() { await atomicJson(stateFile, { version: 1, repositoryFingerprint: fingerprint, jobs, snapshots, lastSuccessfulBackup, lastCheck, lastVerification }) }
  try { await persist() }
  catch { return disabledManager('Backup history could not be written. Repair backup workspace permissions or free space; existing history is preserved.') }
  try {
    if (config.binary && !path.isAbsolute(config.binary)) throw new Error('BACKUP_RESTIC_BINARY must be an absolute path')
    const result = await runner({ binary, args: ['version'], cwd: controlRoot, env: { PATH: env.PATH, HOME: env.HOME }, timeoutMs: 3000 })
    const match = /^restic ([0-9]+\.[0-9]+\.[0-9]+)/.exec(result.stdout.trim())
    if (result.code !== 0 || !match) throw new Error('restic executable did not report a supported version')
    version = match[1]!
    const [major, minor] = version.split('.').map(Number)
    if (major === 0 && minor! < 17) reason = `restic ${version} is too old. Install restic 0.17.0 or newer for verified restores, then restart the service.`
    else available = true
  } catch { reason = 'restic is not installed or cannot run. Install restic on the server and restart the service.' }
  if (available) {
    try {
      if (!config.repository || !config.passwordFile) throw new Error('Set BACKUP_REPOSITORY and BACKUP_PASSWORD_FILE on the server.')
      if (!path.isAbsolute(config.passwordFile)) throw new Error('BACKUP_PASSWORD_FILE must be an absolute path.')
      const passwordStat = await regularFile(config.passwordFile)
      if (passwordStat.size === 0 || passwordStat.size > 64 * 1024 || (process.platform !== 'win32' && (passwordStat.mode & 0o077) !== 0)) throw new Error('Backup password file must be nonempty, at most 64 KiB, and private (0600).')
      const pass = await fs.realpath(config.passwordFile)
      if (inside(pass, dataRoot) || inside(pass, stateRoot)) throw new Error('Store the backup password file outside DATA_ROOT and STATE_ROOT.')
      if (path.isAbsolute(config.repository) || config.repository.startsWith('local:')) {
        const local = path.resolve(config.repository.replace(/^local:/, ''))
        let canonical: string
        try { canonical = await fs.realpath(local) } catch { throw new Error('Initialize the dedicated backup repository before enabling backups.') }
        if (overlaps(canonical, dataRoot) || overlaps(canonical, stateRoot)) throw new Error('The backup repository must not overlap DATA_ROOT or STATE_ROOT.')
      } else if (!/^(sftp:|rest:https:\/\/|s3:https?:\/\/|b2:|azure:|gs:|swift:|rclone:)/.test(config.repository)) {
        throw new Error('Use an absolute local repository path or a supported encrypted remote repository.')
      }
    } catch (error) { reason = error instanceof Error && !('code' in error) ? error.message : 'The backup password file or repository configuration is unavailable.' }
  }
  const configured = available && !reason
  const safeJob = (job: BackupJob) => structuredClone(job)
  function status(): BackupStatus {
    return {
      engine: 'restic', configured, available, ...(reason ? { reason } : {}), ...(version ? { version } : {}),
      activeJob: jobs.find((job) => job.status === 'running') && safeJob(jobs.find((job) => job.status === 'running')!),
      jobs: jobs.map(safeJob), snapshots: structuredClone(snapshots),
      lastSuccessfulBackup: lastSuccessfulBackup && safeJob(lastSuccessfulBackup),
      lastCheck: lastCheck && safeJob(lastCheck),
      lastVerification: lastVerification && safeJob(lastVerification),
    }
  }
  async function command(job: BackupJob, args: string[], cwd = controlRoot) {
    let summary: Record<string, unknown> | undefined
    const result = await runner({ binary, args: ['--json', ...args], cwd, env, onJson(value) {
      if (value.message_type === 'summary') summary = value
      if (value.message_type === 'status') {
        const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined
        job.progress = { filesDone: number(value.files_done ?? value.files_restored), filesTotal: number(value.total_files), bytesDone: number(value.bytes_done ?? value.bytes_restored), bytesTotal: number(value.total_bytes), percent: number(value.percent_done) }
      }
    } })
    if (result.code !== 0) throw new Error(`restic ${args[0]} failed (exit ${result.code}). Check server-side repository access and integrity; no production files were overwritten.`)
    if (!summary) for (const line of result.stdout.trim().split('\n')) try { const value = JSON.parse(line); if (value.message_type === 'summary') summary = value } catch {}
    return { ...result, summary }
  }
  async function refresh(job: BackupJob) {
    const result = await command(job, ['snapshots', '--tag', TAG])
    const rows: unknown = JSON.parse(result.stdout)
    if (!Array.isArray(rows)) throw new Error('restic returned an invalid snapshot list')
    snapshots = rows.map((row: any): BackupSnapshot => {
      if (!row || !ID.test(row.id) || !Number.isFinite(Date.parse(row.time)) || !row.tags?.includes(TAG)) throw new Error('restic returned an invalid snapshot')
      return { id: row.id, createdAt: Date.parse(row.time), files: row.summary?.total_files_processed, bytes: row.summary?.total_bytes_processed }
    }).sort((a, b) => b.createdAt - a.createdAt).slice(0, 500)
  }
  async function backup(job: BackupJob) {
    const work = path.join(workRoot, job.id), staging = path.join(work, 'snapshot')
    await fs.mkdir(work, { mode: 0o700 })
    await fs.mkdir(staging, { mode: 0o700 })
    try {
      job.phase = 'snapshotting'
      await options.withSnapshot(async () => {
        await snapshotTree(dataRoot, path.join(staging, 'files'), options.link)
        const control = path.join(staging, 'state'); await fs.mkdir(control, { mode: 0o700 })
        for (const name of CONTROL_FILES) {
          const source = path.join(stateRoot, name)
          if (await fs.lstat(source).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error })) await snapshotTree(source, path.join(control, name), options.link)
        }
      })
      job.phase = 'hashing'
      await atomicJson(path.join(staging, 'metadata.json'), { format: 'halloween-restic-v1', createdAt: Date.now(), dataRoot, stateRoot, controlFiles: CONTROL_FILES })
      const summary = await manifest(staging, path.join(staging, 'manifest.jsonl'))
      job.result = summary
      job.phase = 'backing-up'
      const result = await command(job, ['backup', '--tag', TAG, '--host', 'halloween', '.'], staging)
      if (typeof result.summary?.snapshot_id !== 'string' || !ID.test(result.summary.snapshot_id)) throw new Error('restic did not confirm a complete snapshot ID')
      job.snapshotId = result.summary.snapshot_id
      snapshots = [{ id: job.snapshotId, createdAt: job.startedAt, files: summary.files, bytes: summary.bytes }, ...snapshots.filter((snapshot) => snapshot.id !== job.snapshotId)].slice(0, 500)
    } finally { await fs.rm(work, { recursive: true, force: true }) }
  }
  async function verify(job: BackupJob) {
    const id = job.snapshotId!
    const destination = path.join(restoreRoot, job.id)
    await fs.mkdir(destination, { mode: 0o700 })
    const target = path.join(destination, 'content')
    await fs.mkdir(target, { mode: 0o700 })
    let succeeded = false
    try {
      job.phase = 'restoring'
      await command(job, ['restore', id, '--target', target, '--verify', '--overwrite', 'never'])
      job.phase = 'verifying-manifest'
      await regularFile(path.join(target, 'metadata.json'))
      const metadata = JSON.parse(await fs.readFile(path.join(target, 'metadata.json'), 'utf8'))
      if (metadata.format !== 'halloween-restic-v1') throw new Error('The snapshot has no supported application manifest')
      await regularFile(path.join(target, 'manifest.jsonl'))
      const expected = await digestFile(path.join(target, 'manifest.jsonl'))
      const actual = await manifest(target)
      if (actual.manifestSha256 !== expected) throw new Error('Restored snapshot failed its SHA-256 manifest comparison')
      job.result = { ...actual, restoreId: job.id }
      await atomicJson(path.join(destination, 'verification.json'), { snapshotId: id, verifiedAt: Date.now(), ...job.result })
      await fs.rm(target, { recursive: true, force: true })
      succeeded = true
    } finally { if (!succeeded) await fs.rm(destination, { recursive: true, force: true }) }
  }
  async function run(job: BackupJob) {
    try {
      if (job.kind === 'backup') await backup(job)
      else if (job.kind === 'refresh') { job.phase = 'listing-snapshots'; await refresh(job) }
      else if (job.kind === 'check') { job.phase = 'checking-all-data'; await command(job, ['check', '--read-data']) }
      else await verify(job)
      job.status = 'succeeded'; job.phase = 'completed'
    } catch (error) {
      job.status = 'failed'; job.phase = 'failed'
      // Never expose arbitrary child/process/fs diagnostics, paths, repo URLs, or backend credentials.
      const message = error instanceof Error ? error.message : ''
      job.error = /^(restic (backup|snapshots|check|restore) failed \(exit \d+\)|Restored snapshot failed|The snapshot has no|Backup sources contain|Snapshot contains unsupported|restic did not confirm)/.test(message)
        ? message.slice(0, 240) : ['ENOSPC', 'EDQUOT'].includes((error as NodeJS.ErrnoException).code ?? '') ? 'Insufficient space for the backup workspace or restore verification. Production data is unchanged.' : 'Backup job failed. Verify server permissions, available disk space, and repository configuration.'
    } finally {
      job.finishedAt = Date.now()
      const previousSuccess = lastSuccessfulBackup
      if (job.kind === 'backup' && job.status === 'succeeded') lastSuccessfulBackup = safeJob(job)
      if (job.kind === 'check') lastCheck = safeJob(job)
      if (job.kind === 'verify') lastVerification = safeJob(job)
      try { await persist() } catch {
        job.status = 'failed'; job.error = 'The job result could not be persisted. Refresh and verify the repository before relying on this job.'
        if (lastSuccessfulBackup?.id === job.id) lastSuccessfulBackup = previousSuccess
        if (job.kind === 'check') lastCheck = safeJob(job)
        if (job.kind === 'verify') lastVerification = safeJob(job)
      }
    }
  }
  async function start(input: { kind: BackupJobKind; snapshotId?: string }): Promise<BackupJob> {
    if (!configured) throw new HTTPError(503, reason ?? 'Backups are not configured')
    if (!input || !['backup', 'check', 'verify', 'refresh'].includes(input.kind)) throw new HTTPError(400, 'invalid backup job kind')
    if (active) throw new HTTPError(409, 'A backup job is already running')
    if (input.kind === 'verify' && (typeof input.snapshotId !== 'string' || !ID.test(input.snapshotId) || !snapshots.some((snapshot) => snapshot.id === input.snapshotId))) throw new HTTPError(400, 'Select a known snapshot from the refreshed list')
    if (input.kind !== 'verify' && input.snapshotId !== undefined) throw new HTTPError(400, 'snapshotId is only accepted for restore verification')
    const job: BackupJob = { id: randomUUID(), kind: input.kind, status: 'running', startedAt: Date.now(), phase: 'starting', ...(input.kind === 'verify' ? { snapshotId: input.snapshotId } : {}) }
    jobs.unshift(job); jobs.splice(30)
    // Claim before the first await, so two concurrent API calls cannot both start commands.
    let release!: () => void
    active = new Promise<void>((resolve) => { release = resolve })
    try { await persist() }
    catch (error) { jobs.shift(); active = undefined; release(); throw error }
    const done = active
    void run(job).finally(() => { if (active === done) active = undefined; release() })
    return safeJob(job)
  }
  function job(id: string): BackupJob {
    if (!JOB_ID.test(id)) throw new HTTPError(400, 'invalid backup job id')
    const entry = jobs.find((item) => item.id === id)
    if (!entry) throw new HTTPError(404, 'backup job not found')
    return safeJob(entry)
  }
  return { status, start, job, waitForIdle: () => active ?? Promise.resolve() }
}
