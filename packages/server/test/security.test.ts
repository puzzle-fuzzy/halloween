import { describe, expect, test } from 'bun:test'
import { RateLimiter, trustedClientIp } from '../src/index'
import { isBlockedAddress } from '../src/rss'

describe('isBlockedAddress (RSS SSRF guard)', () => {
  const blocked = [
    '127.0.0.1',
    '127.255.255.255', // loopback
    '10.0.0.1',
    '10.255.255.255', // 10/8
    '172.16.0.1',
    '172.31.255.255', // 172.16/12
    '192.168.1.1',
    '192.168.0.255', // 192.168/16
    '169.254.169.254',
    '169.254.0.1', // link-local + cloud metadata
    '100.64.0.1',
    '100.127.255.255', // CGNAT
    '198.18.0.1',
    '198.19.255.255', // benchmark
    '0.0.0.0', // "this host"
    '224.0.0.1',
    '255.255.255.255', // multicast + reserved
    '::',
    '::1', // v6 unspecified + loopback
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1', // v4-mapped
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1', // link-local / ULA / multicast
  ]
  const allowed = [
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.32.0.1', // just outside 172.16/12
    '100.128.0.1', // just outside CGNAT
    '169.255.0.1', // just outside link-local
    '2606:4700:4700::1111',
    '2a00:1450:4001::1',
  ]
  for (const ip of blocked) test(`blocks ${ip}`, () => expect(isBlockedAddress(ip)).toBe(true))
  for (const ip of allowed) test(`allows ${ip}`, () => expect(isBlockedAddress(ip)).toBe(false))
  test('refuses non-IP strings', () => {
    expect(isBlockedAddress('localhost')).toBe(true)
    expect(isBlockedAddress('example.com')).toBe(true)
    expect(isBlockedAddress('')).toBe(true)
  })
})

describe('trustedClientIp (X-Real-IP validation)', () => {
  test('accepts well-formed IPv4', () => {
    expect(trustedClientIp('1.2.3.4')).toBe('1.2.3.4')
    expect(trustedClientIp(' 203.0.113.7 ')).toBe('203.0.113.7')
  })
  test('accepts well-formed IPv6 and strips v4-mapped form', () => {
    expect(trustedClientIp('::1')).toBe('::1')
    expect(trustedClientIp('2001:db8::1')).toBe('2001:db8::1')
    expect(trustedClientIp('::ffff:8.8.8.8')).toBe('8.8.8.8')
  })
  test('rejects malformed or hostile values', () => {
    expect(trustedClientIp('999.1.1.1')).toBeUndefined()
    expect(trustedClientIp('1.2.3')).toBeUndefined()
    expect(trustedClientIp('not-an-ip')).toBeUndefined()
    expect(trustedClientIp('8.8.8.8-X')).toBeUndefined()
    expect(trustedClientIp('<script>')).toBeUndefined()
    expect(trustedClientIp('')).toBeUndefined()
    expect(trustedClientIp(undefined)).toBeUndefined()
  })
})

describe('RateLimiter capacity bound', () => {
  test('evicts the oldest entry instead of growing without limit', () => {
    const now = 1_000_000
    const limiter = new RateLimiter(() => now)
    // key "first" hits its limit of 1 inside a long window
    expect(limiter.allow('first', 1, 60_000)).toBe(true)
    expect(limiter.allow('first', 1, 60_000)).toBe(false)
    // flood with more distinct keys than the cap (windows overlap, nothing expires)
    for (let i = 0; i < 10_100; i++) limiter.allow(`flood-${i}`, 1, 60_000)
    // "first" was evicted by the flood → it starts a fresh entry and is allowed again
    expect(limiter.allow('first', 1, 60_000)).toBe(true)
  })
  test('still enforces limits once the window has passed', () => {
    let now = 0
    const limiter = new RateLimiter(() => now)
    expect(limiter.allow('k', 1, 1_000)).toBe(true)
    expect(limiter.allow('k', 1, 1_000)).toBe(false)
    now = 1_001
    expect(limiter.allow('k', 1, 1_000)).toBe(true)
  })
})
