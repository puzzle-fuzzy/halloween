import { describe, expect, test } from 'bun:test'
import type { ClashProxy } from '../src/main/proxy-parse'
import { parseSubscriptionBody, uniqueNames } from '../src/main/proxy-parse'

function parseOne(uri: string): ClashProxy {
  const [proxy] = parseSubscriptionBody(uri)
  if (!proxy) throw new Error(`did not parse: ${uri}`)
  return proxy
}

describe('parseSubscriptionBody: ss links', () => {
  test('plain userinfo with fragment name', () => {
    const p = parseOne('ss://YWVzLTI1Ni1nY206c2VjcmV0cGFzcw==@1.2.3.4:8388#%E9%A6%99%E6%B8%AF')
    expect(p).toMatchObject({
      name: '香港',
      type: 'ss',
      server: '1.2.3.4',
      port: 8388,
      cipher: 'aes-256-gcm',
      password: 'secretpass',
    })
  })

  test('legacy all-base64 variant', () => {
    const p = parseOne('ss://cmM0LW1kNTpwd0AxLjIuMy40OjQ0Mw==')
    expect(p).toMatchObject({
      type: 'ss',
      server: '1.2.3.4',
      port: 443,
      cipher: 'rc4-md5',
      password: 'pw',
    })
    expect(p.name).toBe('1.2.3.4:443') // no fragment → host:port
  })

  test('undecodable userinfo is rejected, not thrown', () => {
    expect(parseSubscriptionBody('ss://!!!notbase64!!!@1.2.3.4:1')).toHaveLength(0)
  })
})

describe('parseSubscriptionBody: vmess links', () => {
  test('ws + tls fields map to clash keys', () => {
    const p = parseOne(
      'vmess://eyJ2IjoiMiIsInBzIjoi6aaZ5rivIDAxIiwiYWRkIjoidi5leGFtcGxlLmNvbSIsInBvcnQiOiI0NDMiLCJpZCI6ImI4MzEzODFkLTYzMjQtNGQ1My1hZDRmLThjZGE0OGIzMDgxMSIsImFpZCI6IjAiLCJuZXQiOiJ3cyIsImhvc3QiOiJjZG4uZXhhbXBsZS5jb20iLCJwYXRoIjoiL3dzIiwidGxzIjoidGxzIiwic25pIjoicy5leGFtcGxlLmNvbSJ9',
    )
    expect(p).toMatchObject({
      name: '香港 01',
      type: 'vmess',
      server: 'v.example.com',
      port: 443,
      uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
      network: 'ws',
      tls: true,
      servername: 's.example.com',
    })
    expect(p['ws-opts']).toMatchObject({ path: '/ws', headers: { Host: 'cdn.example.com' } })
  })

  test('invalid base64 json is rejected', () => {
    expect(parseSubscriptionBody('vmess://bm90IGpzb24=')).toHaveLength(0)
  })
})

describe('parseSubscriptionBody: trojan links', () => {
  test('password, sni query, fragment name, allowInsecure', () => {
    const p = parseOne(
      'trojan://secretpw@a.example.com:8443?sni=s.example.com&allowInsecure=1#%F0%9F%9A%80%20HK',
    )
    expect(p).toMatchObject({
      name: '🚀 HK',
      type: 'trojan',
      server: 'a.example.com',
      port: 8443,
      password: 'secretpw',
      sni: 's.example.com',
      'skip-cert-verify': true,
    })
  })

  test('default port 443 when absent', () => {
    const p = parseOne('trojan://pw@b.example.com#node')
    expect(p).toMatchObject({ port: 443, sni: 'b.example.com' })
  })
})

describe('parseSubscriptionBody: container formats', () => {
  test('clash yaml document', () => {
    const yaml = `proxies:\n  - {name: y1, type: ss, server: 1.1.1.1, port: 1, cipher: aes-128-gcm, password: a}\n  - {name: y2, type: ss, server: 2.2.2.2, port: 2, cipher: aes-128-gcm, password: b}\n`
    const proxies = parseSubscriptionBody(yaml)
    expect(proxies.map((p) => p.name)).toEqual(['y1', 'y2'])
  })

  test('base64-wrapped link list mixes protocols', () => {
    const proxies = parseSubscriptionBody(
      'dHJvamFuOi8vcHdAYS5leGFtcGxlLmNvbTo0NDM/c25pPXMuZXhhbXBsZS5jb20jdGoKc3M6Ly9ZV1Z6TFRJMU5pMW5ZMjA2YzJWamNtVjBjR0Z6Y3c9PUBiLmV4YW1wbGUuY29tOjgzODgjc3Nub2Rl',
    )
    expect(proxies).toHaveLength(2)
    expect(proxies[0]).toMatchObject({ type: 'trojan', name: 'tj' })
    expect(proxies[1]).toMatchObject({ type: 'ss', name: 'ssnode', server: 'b.example.com' })
  })

  test('garbage and empty input yield an empty list', () => {
    expect(parseSubscriptionBody('')).toHaveLength(0)
    expect(parseSubscriptionBody('<html>login required</html>')).toHaveLength(0)
    expect(parseSubscriptionBody('plain text without any link')).toHaveLength(0)
  })

  test('yaml without a proxies array falls through to link parsing', () => {
    expect(parseSubscriptionBody('port: 7890\nmode: rule\n')).toHaveLength(0)
  })
})

describe('uniqueNames', () => {
  test('duplicate names get a counter suffix', () => {
    const out = uniqueNames([
      { name: 'HK', type: 'ss' },
      { name: 'HK', type: 'ss' },
      { name: 'HK', type: 'ss' },
      { name: 'JP', type: 'ss' },
    ])
    expect(out.map((p) => p.name)).toEqual(['HK', 'HK (2)', 'HK (3)', 'JP'])
  })

  test('input objects are not mutated', () => {
    const original = [
      { name: 'a', type: 'ss' },
      { name: 'a', type: 'ss' },
    ]
    uniqueNames(original)
    expect(original.map((p) => p.name)).toEqual(['a', 'a'])
  })
})
