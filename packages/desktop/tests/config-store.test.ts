import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { applyServerOverride, createConfigStore, type TokenCipher } from '../src/main/config-store'

const directories: string[] = []
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'halloween-config-test-'))
  directories.push(dir)
  return path.join(dir, 'cloud-config.json')
}
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))) })
const cipher: TokenCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value.split('').reverse().join('')),
  decryptString: (value) => value.toString().split('').reverse().join(''),
}

test('migrates a plaintext token, preserves the endpoint and limits file permissions', async () => {
  const filename = await fixture()
  const config = { serverUrl: 'https://example.invalid/cloud', token: 'private-device-token' }
  await fs.writeFile(filename, JSON.stringify(config))
  const store = createConfigStore(filename, cipher)
  expect(await store.load()).toEqual(config)
  const persisted = await fs.readFile(filename, 'utf8')
  expect(persisted).not.toContain(config.token)
  expect(JSON.parse(persisted).token).toBeUndefined()
  expect(await store.load()).toEqual(config)
  if (process.platform !== 'win32') expect((await fs.stat(filename)).mode & 0o777).toBe(0o600)
  await store.save({ ...config, token: '' })
  expect((await store.load()).token).toBe('')
})

test('does not silently downgrade encryption or destroy the old sign-in when the keychain is locked', async () => {
  const filename = await fixture()
  const original = JSON.stringify({ serverUrl: 'https://example.invalid/cloud', token: 'old-token' })
  await fs.writeFile(filename, original)
  const store = createConfigStore(filename, { ...cipher, isEncryptionAvailable: () => false })
  await expect(store.load()).rejects.toThrow('encryption is unavailable')
  expect(await fs.readFile(filename, 'utf8')).toBe(original)
})

test('an unreadable encrypted sign-in produces an actionable error', async () => {
  const filename = await fixture()
  await createConfigStore(filename, cipher).save({ serverUrl: 'https://example.invalid/cloud', token: 'token' })
  await expect(createConfigStore(filename, { ...cipher, decryptString: () => { throw new Error('invalid cipher') } }).load())
    .rejects.toThrow('could not be decrypted')
})

test('rejects corrupt configuration types and insecure Linux basic_text storage', async () => {
  const filename = await fixture()
  for (const value of [null, [], { token: 123 }, { serverUrl: [] }, { encryptedToken: false }]) {
    await fs.writeFile(filename, JSON.stringify(value))
    await expect(createConfigStore(filename, cipher).load()).rejects.toThrow('Unable to read saved cloud configuration')
  }
  await expect(createConfigStore(filename, { ...cipher, getSelectedStorageBackend: () => 'basic_text' })
    .save({ serverUrl: 'https://example.invalid/cloud', token: 'private' })).rejects.toThrow('encryption is unavailable')
})

test('development endpoint overrides cannot forward a sign-in to another endpoint', () => {
  const config = { serverUrl: 'https://example.invalid/cloud', token: 'existing-token' }
  expect(applyServerOverride(config)).toEqual(config)
  expect(applyServerOverride(config, 'https://example.invalid/cloud/')).toEqual(config)
  expect(applyServerOverride(config, 'http://127.0.0.1:3690/cloud').token).toBe('')
  expect(applyServerOverride(config, 'https://example.invalid/another-service').token).toBe('')
  expect(() => applyServerOverride(config, 'file:///tmp/cloud')).toThrow('Invalid HALLOWEEN_SERVER_URL')
})
