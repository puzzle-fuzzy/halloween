import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { backupConfigFromEnv, createBackupManager, snapshotTree, spawnRestic } from '../src/backups'
import type { ResticRequest, ResticRunner } from '../src/backups'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })
const SNAPSHOT = 'a'.repeat(64)
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'halloween-backups-test-')); roots.push(root)
  const dataRoot = path.join(root, 'data'), stateRoot = path.join(root, 'state'), repository = path.join(root, 'repo'), passwordFile = path.join(root, 'password')
  for (const directory of [dataRoot, stateRoot, repository]) await fs.mkdir(directory, { mode: 0o700 })
  await fs.writeFile(passwordFile, 'fixture-password-only', { mode: 0o600 })
  await fs.writeFile(path.join(dataRoot, 'movie.bin'), 'test movie content', { mode: 0o600 })
  await fs.mkdir(path.join(dataRoot, 'empty'), { mode: 0o700 })
  await fs.writeFile(path.join(stateRoot, 'tokens.json'), '{"tokens":[]}', { mode: 0o600 })
  await fs.writeFile(path.join(stateRoot, 'oss-accounts.json'), '{"accounts":[]}', { mode: 0o600 })
  await fs.mkdir(path.join(stateRoot, 'trash'), { mode: 0o700 })
  await fs.writeFile(path.join(stateRoot, 'trash', 'example'), 'recoverable', { mode: 0o600 })
  let locked = false, snapshotCalls = 0
  const withSnapshot = async <T>(work: () => Promise<T>) => {
    expect(locked).toBe(false); locked = true; snapshotCalls++
    try { return await work() } finally { locked = false }
  }
  return { root, dataRoot, stateRoot, config: { repository, passwordFile }, withSnapshot, get locked() { return locked }, get snapshotCalls() { return snapshotCalls } }
}
async function fake(f: Awaited<ReturnType<typeof fixture>>) {
  const calls: ResticRequest[] = [], stored = path.join(f.root, 'stored-snapshot')
  let failCode = 0, tamper = false, gate: Promise<void> | undefined
  const runner: ResticRunner = async (request) => {
    calls.push(request)
    if (request.args[0] === 'version') return { code: 0, stdout: 'restic 0.19.1 compiled with go1.25' }
    expect(f.locked).toBe(false)
    if (gate) await gate
    if (failCode) return { code: failCode, stdout: 'secret-repo-and-password-must-not-be-returned' }
    if (request.args.includes('backup')) {
      await fs.cp(request.cwd, stored, { recursive: true, preserveTimestamps: true })
      const summary = { message_type: 'summary', snapshot_id: SNAPSHOT }
      request.onJson?.({ message_type: 'status', percent_done: 0.5, bytes_done: 10, total_bytes: 20 })
      request.onJson?.(summary)
      return { code: 0, stdout: JSON.stringify(summary) + '\n' }
    }
    if (request.args.includes('snapshots')) return { code: 0, stdout: JSON.stringify([{ id: SNAPSHOT, time: new Date().toISOString(), tags: ['halloween-personal-cloud-v1'] }]) }
    if (request.args.includes('restore')) {
      const target = request.args[request.args.indexOf('--target') + 1]!
      await fs.cp(stored, target, { recursive: true, preserveTimestamps: true })
      if (tamper) await fs.writeFile(path.join(target, 'files/movie.bin'), 'corrupt restored content')
    }
    return { code: 0, stdout: '' }
  }
  const manager = await createBackupManager({ ...f, runner })
  return { manager, calls, stored, setFail: (code: number) => { failCode = code }, setTamper: () => { tamper = true }, setGate: (promise: Promise<void>) => { gate = promise } }
}

test('missing restic/configuration is visible and refuses jobs; status never spawns remote commands', async () => {
  const f = await fixture()
  const manager = await createBackupManager({ ...f, runner: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) } })
  expect(manager.status()).toMatchObject({ configured: false, available: false })
  expect(manager.status().reason).toContain('restic')
  await expect(manager.start({ kind: 'backup' })).rejects.toThrow('restic')
  const ok = await fake(f), count = ok.calls.length
  for (let index = 0; index < 100; index++) ok.manager.status()
  expect(ok.calls.length).toBe(count)
})

test('restic versions older than 0.17 are rejected during probing with an explicit upgrade reason', async () => {
  const f = await fixture()
  for (const version of ['0.1.0', '0.16.99']) {
    const manager = await createBackupManager({ ...f, runner: async () => ({ code: 0, stdout: `restic ${version} compiled with go` }) })
    expect(manager.status()).toMatchObject({ configured: false, available: false, version })
    expect(manager.status().reason).toContain('too old')
    expect(manager.status().reason).toContain('0.17.0')
    await expect(manager.start({ kind: 'backup' })).rejects.toThrow('0.17.0')
  }
  for (const version of ['0.17.0', '1.0.0']) {
    const manager = await createBackupManager({ ...f, runner: async () => ({ code: 0, stdout: `restic ${version}` }) })
    expect(manager.status()).toMatchObject({ configured: true, available: true, version })
  }
})

test('backup captures stable cloud/control/trash data under the lock, then hashes and runs restic outside it', async () => {
  const f = await fixture(), engine = await fake(f)
  const job = await engine.manager.start({ kind: 'backup' })
  await engine.manager.waitForIdle()
  expect(engine.manager.job(job.id)).toMatchObject({ status: 'succeeded', snapshotId: SNAPSHOT })
  expect(f.snapshotCalls).toBe(1)
  expect(await fs.readFile(path.join(engine.stored, 'files/movie.bin'), 'utf8')).toBe('test movie content')
  expect(await fs.readFile(path.join(engine.stored, 'state/trash/example'), 'utf8')).toBe('recoverable')
  expect(await fs.readdir(path.join(engine.stored, 'state'))).not.toContain('backups')
  expect(await fs.readdir(path.join(f.stateRoot, 'backups/work'))).toEqual([])
  expect(engine.manager.status().lastSuccessfulBackup?.id).toBe(job.id)
  expect(engine.manager.status().snapshots[0]?.id).toBe(SNAPSHOT)
  const restarted = await createBackupManager({ ...f, runner: async () => ({ code: 0, stdout: 'restic 0.19.1' }) })
  expect(restarted.status().lastSuccessfulBackup?.id).toBe(job.id)
})

test('independent full repository check is asynchronous and excludes another running job', async () => {
  const f = await fixture(), engine = await fake(f)
  let release!: () => void
  engine.setGate(new Promise<void>((resolve) => { release = resolve }))
  const job = await engine.manager.start({ kind: 'check' })
  expect(job.status).toBe('running')
  await expect(engine.manager.start({ kind: 'backup' })).rejects.toThrow('already running')
  release(); await engine.manager.waitForIdle()
  expect(engine.calls.some((request) => request.args.join(' ') === '--json check --read-data')).toBe(true)
  expect(engine.manager.status().lastCheck?.status).toBe('succeeded')
})

test('restore verification compares SHA-256 manifests in a new private destination, never production', async () => {
  const f = await fixture(), engine = await fake(f)
  await engine.manager.start({ kind: 'backup' }); await engine.manager.waitForIdle()
  const job = await engine.manager.start({ kind: 'verify', snapshotId: SNAPSHOT }); await engine.manager.waitForIdle()
  expect(engine.manager.job(job.id).status).toBe('succeeded')
  const restore = engine.calls.find((request) => request.args.includes('restore'))!
  const target = restore.args[restore.args.indexOf('--target') + 1]!
  expect(target.startsWith(path.join(await fs.realpath(f.stateRoot), 'backups/restores/'))).toBe(true)
  expect(target).not.toBe(f.dataRoot)
  expect(await fs.readFile(path.join(f.dataRoot, 'movie.bin'), 'utf8')).toBe('test movie content')
  expect(engine.manager.job(job.id).result?.restoreId).toBe(job.id)
  expect(await fs.stat(target).then(() => true, () => false)).toBe(false)
  engine.setTamper()
  const bad = await engine.manager.start({ kind: 'verify', snapshotId: SNAPSHOT }); await engine.manager.waitForIdle()
  expect(engine.manager.job(bad.id)).toMatchObject({ status: 'failed' })
  expect(engine.manager.job(bad.id).error).toContain('SHA-256')
  expect(await fs.stat(path.join(f.stateRoot, 'backups/restores', bad.id)).then(() => true, () => false)).toBe(false)
})

test('partial backup exit and unsafe IDs do not claim success or leak diagnostics', async () => {
  const f = await fixture(), engine = await fake(f)
  for (const snapshotId of ['latest', '../data', '--target=/srv/data', 'a'.repeat(64)]) {
    await expect(engine.manager.start({ kind: 'verify', snapshotId })).rejects.toThrow('known snapshot')
  }
  expect(() => engine.manager.job('../jobs.json')).toThrow('invalid backup job id')
  engine.setFail(3)
  const job = await engine.manager.start({ kind: 'backup' }); await engine.manager.waitForIdle()
  expect(engine.manager.job(job.id).status).toBe('failed')
  expect(engine.manager.status().lastSuccessfulBackup).toBeUndefined()
  expect(JSON.stringify(engine.manager.status())).not.toContain('secret-repo-and-password')
  expect(await fs.readdir(path.join(f.stateRoot, 'backups/work'))).toEqual([])
})

test('stable snapshots use hard links and cross-volume fallback without following symlinks', async () => {
  const f = await fixture()
  const linked = path.join(f.root, 'linked'), copied = path.join(f.root, 'copied')
  await snapshotTree(f.dataRoot, linked)
  expect((await fs.stat(path.join(linked, 'movie.bin'))).ino).toBe((await fs.stat(path.join(f.dataRoot, 'movie.bin'))).ino)
  await snapshotTree(f.dataRoot, copied, async () => { throw Object.assign(new Error('cross device'), { code: 'EXDEV' }) })
  expect((await fs.stat(path.join(copied, 'movie.bin'))).ino).not.toBe((await fs.stat(path.join(f.dataRoot, 'movie.bin'))).ino)
  expect(await fs.readFile(path.join(copied, 'movie.bin'), 'utf8')).toBe('test movie content')
  await fs.symlink(f.config.passwordFile, path.join(f.dataRoot, 'secret-link'))
  const engine = await fake(f), job = await engine.manager.start({ kind: 'backup' }); await engine.manager.waitForIdle()
  expect(engine.manager.job(job.id).status).toBe('failed')
  expect(engine.calls.some((request) => request.args.includes('backup'))).toBe(false)
  expect(await fs.readdir(path.join(f.stateRoot, 'backups/work'))).toEqual([])
})

test('a snapshot staging disk failure removes generated files without changing original data', async () => {
  const f = await fixture()
  const manager = await createBackupManager({ ...f,
    runner: async () => ({ code: 0, stdout: 'restic 0.19.1 unexpected-secret-must-not-be-displayed' }),
    link: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) },
  })
  expect(manager.status().version).toBe('0.19.1')
  const job = await manager.start({ kind: 'backup' }); await manager.waitForIdle()
  expect(manager.job(job.id).error).toContain('Insufficient space')
  expect(await fs.readFile(path.join(f.dataRoot, 'movie.bin'), 'utf8')).toBe('test movie content')
  expect(await fs.readdir(path.join(f.stateRoot, 'backups/work'))).toEqual([])
})

test('restart marks interrupted jobs, cleans only generated payloads, and retains the durable last-success summary', async () => {
  const f = await fixture(), engine = await fake(f)
  const backup = await engine.manager.start({ kind: 'backup' }); await engine.manager.waitForIdle()
  const statusFile = path.join(f.stateRoot, 'backups/jobs.json')
  const saved = JSON.parse(await fs.readFile(statusFile, 'utf8'))
  saved.jobs = [{ ...saved.jobs[0], status: 'running', kind: 'verify' }]
  await fs.writeFile(statusFile, JSON.stringify(saved))
  const leftover = path.join(f.stateRoot, 'backups/restores', backup.id)
  await fs.mkdir(path.join(leftover, 'content'), { recursive: true })
  await fs.writeFile(path.join(leftover, 'content/partial'), 'partial restored data')
  const restarted = await createBackupManager({ ...f, runner: async () => ({ code: 0, stdout: 'restic 0.19.1' }) })
  expect(restarted.job(backup.id).status).toBe('interrupted')
  expect(restarted.status().lastSuccessfulBackup?.id).toBe(backup.id)
  expect(await fs.stat(path.join(leftover, 'content')).then(() => true, () => false)).toBe(false)
})

test.skipIf(process.platform === 'win32')('repository changes, insecure password permissions, and inherited master credentials stay isolated', async () => {
  const f = await fixture(), engine = await fake(f)
  await engine.manager.start({ kind: 'backup' }); await engine.manager.waitForIdle()
  const other = path.join(f.root, 'other-repo'); await fs.mkdir(other)
  const changed = await createBackupManager({ ...f, config: { ...f.config, repository: other }, runner: async () => ({ code: 0, stdout: 'restic 0.19.1' }) })
  expect(changed.status().snapshots).toEqual([])
  expect(changed.status().lastSuccessfulBackup).toBeUndefined()
  await fs.chmod(f.config.passwordFile, 0o644)
  const insecure = await createBackupManager({ ...f, runner: async () => ({ code: 0, stdout: 'restic 0.19.1' }) })
  expect(insecure.status().configured).toBe(false)
  const config = backupConfigFromEnv({ BACKUP_REPOSITORY: 'rest:https://backup.invalid/repo', BACKUP_PASSWORD_FILE: '/etc/private-backup', TOKEN: 'MASTER_SECRET', ADMIN_PASSWORD: 'ADMIN_SECRET', RESTIC_PASSWORD_COMMAND: 'evil', AWS_SECRET_ACCESS_KEY: 'backend-only' })
  expect(config.backendEnv?.TOKEN).toBeUndefined()
  expect(config.backendEnv?.ADMIN_PASSWORD).toBeUndefined()
  expect(config.backendEnv?.RESTIC_PASSWORD_COMMAND).toBeUndefined()
  expect(config.backendEnv?.AWS_SECRET_ACCESS_KEY).toBe('backend-only')
})

test('corrupt backup history is preserved and disables only backup jobs', async () => {
  const f = await fixture(); await fake(f)
  const filename = path.join(f.stateRoot, 'backups/jobs.json')
  await fs.writeFile(filename, '{broken-history')
  let calls = 0
  const manager = await createBackupManager({ ...f, runner: async () => { calls++; throw new Error('should not run') } })
  expect(manager.status().configured).toBe(false)
  expect(manager.status().reason).toContain('metadata')
  expect(calls).toBe(0)
  await expect(manager.start({ kind: 'backup' })).rejects.toThrow('metadata')
  expect(await fs.readFile(filename, 'utf8')).toBe('{broken-history')
  expect(await fs.readFile(path.join(f.dataRoot, 'movie.bin'), 'utf8')).toBe('test movie content')
})

test('an unsafe backup workspace disables backups without traversing or modifying its symlink target', async () => {
  const f = await fixture()
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside)
  await fs.symlink(outside, path.join(f.stateRoot, 'backups'))
  const manager = await createBackupManager({ ...f, runner: async () => { throw new Error('must not run') } })
  expect(manager.status().configured).toBe(false)
  expect(manager.status().reason).toContain('workspace')
  expect(await fs.readdir(outside)).toEqual([])
})

test.skipIf(!process.env.BACKUP_TEST_RESTIC_BINARY)('real restic: encrypted temporary repository, backup, read-data check and restore verification', async () => {
  const f = await fixture(), binary = process.env.BACKUP_TEST_RESTIC_BINARY!
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, RESTIC_REPOSITORY: f.config.repository, RESTIC_PASSWORD_FILE: f.config.passwordFile }
  const init = await spawnRestic({ binary, args: ['init', '--repository-version', '2'], cwd: f.root, env })
  expect(init.code).toBe(0)
  const manager = await createBackupManager({ ...f, config: { ...f.config, binary } })
  expect(manager.status().configured).toBe(true)
  const backup = await manager.start({ kind: 'backup' }); await manager.waitForIdle()
  expect(manager.job(backup.id).error).toBeUndefined()
  expect(manager.job(backup.id).status).toBe('succeeded')
  const check = await manager.start({ kind: 'check' }); await manager.waitForIdle()
  expect(manager.job(check.id).status).toBe('succeeded')
  const refresh = await manager.start({ kind: 'refresh' }); await manager.waitForIdle()
  expect(manager.job(refresh.id).status).toBe('succeeded')
  const verify = await manager.start({ kind: 'verify', snapshotId: manager.status().snapshots[0]!.id }); await manager.waitForIdle()
  expect(manager.job(verify.id).error).toBeUndefined()
  expect(manager.job(verify.id).status).toBe('succeeded')
  expect(await fs.readFile(path.join(f.dataRoot, 'movie.bin'), 'utf8')).toBe('test movie content')
  // Corrupt only this test repository's pack to prove check failure is observable.
  const data = path.join(f.config.repository, 'data')
  // Repository data directories may include empty hexadecimal prefixes.
  let corrupted = false
  for (const entry of await fs.readdir(data)) {
    const directory = path.join(data, entry)
    const filenames = await fs.readdir(directory)
    if (filenames[0]) {
      const pack = path.join(directory, filenames[0])
      await fs.chmod(pack, 0o600)
      await fs.writeFile(pack, 'corrupt-test-pack'); corrupted = true; break
    }
  }
  expect(corrupted).toBe(true)
  const corruptCheck = await manager.start({ kind: 'check' }); await manager.waitForIdle()
  expect(manager.job(corruptCheck.id).status).toBe('failed')
  expect(manager.status().lastCheck?.id).toBe(corruptCheck.id)
}, 120_000)
