import { expect, test } from 'bun:test'
import { setTimeout as delay } from 'node:timers/promises'
import { parseDevicePoll, SignInAttempt, verifySignIn } from '../src/main/auth'

test('revoked credentials require sign-in; service and network failures remain retryable errors', async () => {
  const config = { serverUrl: 'https://example.invalid/cloud', token: 'test-token' }
  for (const status of [401, 403]) {
    expect(await verifySignIn(config, async () => new Response(null, { status }))).toBe(false)
  }
  expect(await verifySignIn(config, async () => new Response('{}'))).toBe(true)
  await expect(
    verifySignIn(config, async () => new Response(null, { status: 500 })),
  ).rejects.toThrow('HTTP 500')
  await expect(
    verifySignIn(config, async () => {
      throw new Error('offline')
    }),
  ).rejects.toThrow('offline')
  expect(
    await verifySignIn({ ...config, token: '' }, async () => {
      throw new Error('should not request')
    }),
  ).toBe(false)
})

test('authorization denial, expiration and server errors stop polling immediately', () => {
  expect(parseDevicePoll(200, { status: 'pending' })).toBeNull()
  expect(parseDevicePoll(200, { status: 'approved', token: 'new-token' })).toBe('new-token')
  expect(() => parseDevicePoll(403)).toThrow('denied')
  expect(() => parseDevicePoll(410)).toThrow('expired')
  expect(() => parseDevicePoll(503)).toThrow('HTTP 503')
  expect(() => parseDevicePoll(200, { status: 'approved' })).toThrow('invalid sign-in response')
})

test('concurrent login calls share one attempt, and logout aborts it before clearing credentials', async () => {
  const login = new SignInAttempt()
  let requests = 0
  let saved = false
  const task = async (signal: AbortSignal) => {
    requests++
    await delay(1000, undefined, { signal })
    signal.throwIfAborted()
    saved = true
    return { ok: true }
  }
  const first = login.run(task)
  const second = login.run(task)
  expect(first).toBe(second)
  const settled = first.then(
    () => null,
    (error: unknown) => error,
  )
  await Promise.resolve()
  let cleared = false
  await login.cancel(async () => {
    cleared = true
  })
  expect(await settled).toBeInstanceOf(Error)
  expect(requests).toBe(1)
  expect(saved).toBe(false)
  expect(cleared).toBe(true)
  expect(await login.run(async () => ({ ok: true }))).toEqual({ ok: true })
})
