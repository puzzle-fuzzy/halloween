import { expect, test } from 'bun:test'
import { TransferRegistry, type TransferProgress } from '../src/main/transfers'

test('bytes sent do not complete an upload; only the confirmed terminal status does', () => {
  const registry = new TransferRegistry()
  const events: TransferProgress[] = []
  registry.notify = (entry) => events.push(entry)
  const id = registry.start('upload', 'large-file', 100)
  registry.progress(id, 100)
  expect(registry.list()[0]?.status).toBe('running')
  registry.fail(id, new Error('Server rejected the upload'))
  expect(events.at(-1)).toMatchObject({ id, status: 'failed', error: 'Server rejected the upload' })
  registry.progress(id, 20)
  expect(registry.list()[0]?.loaded).toBe(100)
})

test('keeps active transfers while bounding completed history and returning independent snapshots', () => {
  const registry = new TransferRegistry(2)
  const active = registry.start('download', 'active')
  for (let index = 0; index < 5; index++) registry.complete(registry.start('download', String(index)))
  const list = registry.list()
  expect(list.length).toBe(3)
  expect(list.find((entry) => entry.id === active)?.status).toBe('running')
  list[0]!.name = 'changed outside'
  expect(registry.list()[0]?.name).toBe('active')
})

test('cancellation aborts the operation and keeps its terminal state after later callbacks', () => {
  const registry = new TransferRegistry()
  const id = registry.start('download', 'cancel-me')
  const signal = registry.signal(id)!
  registry.cancel(id)
  expect(signal.aborted).toBe(true)
  registry.fail(id, new Error('aborted'))
  registry.complete(id)
  registry.progress(id, 100)
  expect(registry.list()[0]?.status).toBe('cancelled')
  expect(registry.list()[0]?.loaded).toBe(0)
})
