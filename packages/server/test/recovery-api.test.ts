import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { BackupStatus, TrashListing } from '@halloween/contracts'
import type { ApplicationOptions } from '../src/index'
import { createApplication } from '../src/index'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})
const token = 'recovery-api-fixture-token-'.repeat(2)
async function fixture(overrides: Partial<ApplicationOptions> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'halloween-recovery-api-'))
  temporary.push(root)
  const options = {
    dataRoot: path.join(root, 'files'),
    stateRoot: path.join(root, 'state'),
    token,
    adminPassword: 'recovery-test-admin-password',
    quiet: true,
    ...overrides,
  }
  const app = await createApplication(options)
  const request = (url: string, method = 'GET', body?: unknown, authenticated = true) =>
    app.request(`http://localhost/cloud/api${url}`, {
      method,
      headers: {
        ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  return { root, options, request }
}

test('recovery APIs enforce authentication and validate mutation bodies', async () => {
  const f = await fixture()
  for (const url of ['/trash', '/backups/status', '/backups/jobs/invalid'])
    expect((await f.request(url, 'GET', undefined, false)).status).toBe(401)
  expect((await f.request('/trash/restore', 'POST', { id: 42 })).status).toBe(400)
  expect(
    (await f.request('/trash/purge', 'POST', { ids: ['../tokens.json'], confirmation: 'DELETE' }))
      .status,
  ).toBe(400)
  expect(
    (await f.request('/backups/jobs', 'POST', { kind: 'shell', command: 'arbitrary' })).status,
  ).toBe(400)
  expect((await f.request('/backups/jobs/invalid')).status).toBe(400)
})

test('cloud API restores a conflict under a new name while preserving both versions', async () => {
  const f = await fixture()
  await fs.writeFile(path.join(f.options.dataRoot, 'report.txt'), 'original')
  expect((await f.request('/delete', 'POST', { paths: ['/report.txt'] })).status).toBe(200)
  const listing = (await (await f.request('/trash')).json()) as TrashListing
  expect(listing.entries).toHaveLength(1)
  expect(listing.totalBytes).toBe(8)
  const id = listing.entries[0].id
  await fs.writeFile(path.join(f.options.dataRoot, 'report.txt'), 'new version')
  expect((await f.request('/trash/restore', 'POST', { id })).status).toBe(409)
  expect(
    (await f.request('/trash/restore', 'POST', { id, destination: '/report-restored.txt' })).status,
  ).toBe(200)
  expect(await fs.readFile(path.join(f.options.dataRoot, 'report.txt'), 'utf8')).toBe('new version')
  expect(await fs.readFile(path.join(f.options.dataRoot, 'report-restored.txt'), 'utf8')).toBe(
    'original',
  )
  expect(((await (await f.request('/trash')).json()) as TrashListing).entries).toEqual([])
})

test('permanent purge requires the exact confirmation, then refreshes the correct total', async () => {
  const f = await fixture()
  for (const name of ['first.txt', 'second.txt'])
    await fs.writeFile(path.join(f.options.dataRoot, name), name)
  await f.request('/delete', 'POST', { paths: ['/first.txt', '/second.txt'] })
  expect(
    (await f.request('/trash/purge', 'POST', { all: true, confirmation: 'DELETE' })).status,
  ).toBe(400)
  expect(((await (await f.request('/trash')).json()) as TrashListing).entries).toHaveLength(2)
  expect(
    (await f.request('/trash/purge', 'POST', { all: true, confirmation: 'EMPTY_TRASH' })).status,
  ).toBe(200)
  expect(await (await f.request('/trash')).json()).toEqual({
    entries: [],
    totalBytes: 0,
    incomplete: false,
  })
})

test('an unavailable backup engine is reported honestly while normal cloud APIs keep working', async () => {
  const f = await fixture({
    backupRunner: async () => {
      throw new Error('No engine')
    },
  })
  const result = (await (await f.request('/backups/status')).json()) as BackupStatus
  expect(result).toMatchObject({ configured: false, available: false, jobs: [] })
  expect((await f.request('/backups/jobs', 'POST', { kind: 'backup' })).status).toBe(503)
  expect((await f.request('/files')).status).toBe(200)
  expect((await f.request('/trash')).status).toBe(200)
  expect(JSON.stringify(result)).not.toContain(token)
})

test('corrupt backup history disables only backups and preserves the corrupt file for repair', async () => {
  const f = await fixture()
  const journal = path.join(f.options.stateRoot, 'backups/jobs.json')
  await fs.writeFile(journal, '{broken-backup-history')
  const app = await createApplication(f.options)
  const headers = { Authorization: `Bearer ${token}` }
  expect((await app.request('http://localhost/cloud/api/files', { headers })).status).toBe(200)
  expect((await app.request('http://localhost/cloud/api/trash', { headers })).status).toBe(200)
  const result = (await (
    await app.request('http://localhost/cloud/api/backups/status', { headers })
  ).json()) as BackupStatus
  expect(result.configured).toBe(false)
  expect(result.reason).toContain('metadata')
  expect(await fs.readFile(journal, 'utf8')).toBe('{broken-backup-history')
})
