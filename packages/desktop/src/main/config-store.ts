import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export interface CloudConfig {
  serverUrl: string
  token: string
}
export const DEFAULT_SERVER_URL = 'https://halloween.yxswy.com/cloud'

export function applyServerOverride(config: CloudConfig, override?: string): CloudConfig {
  if (!override) return config
  const endpoint = new URL(override)
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error('Invalid HALLOWEEN_SERVER_URL')
  }
  const serverUrl = endpoint.toString().replace(/\/$/, '')
  return { serverUrl, token: config.serverUrl.replace(/\/$/, '') === serverUrl ? config.token : '' }
}

export interface TokenCipher {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  getSelectedStorageBackend?(): string
}

/** The cipher is injected so migrations can be verified without the OS keychain. */
export function createConfigStore(filename: string, cipher: TokenCipher) {
  const canEncrypt = () =>
    cipher.isEncryptionAvailable() && cipher.getSelectedStorageBackend?.() !== 'basic_text'
  const save = async (config: CloudConfig): Promise<void> => {
    if (config.token && !canEncrypt()) {
      throw new Error(
        'System credential encryption is unavailable. Unlock your keychain and try again.',
      )
    }
    const value = {
      serverUrl: config.serverUrl,
      encryptedToken: config.token ? cipher.encryptString(config.token).toString('base64') : '',
    }
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
    const temporary = `${filename}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' })
      await fs.rename(temporary, filename)
      await fs.chmod(filename, 0o600)
    } finally {
      await fs.rm(temporary, { force: true })
    }
  }
  const load = async (): Promise<CloudConfig> => {
    let raw: { serverUrl?: string; token?: string; encryptedToken?: string }
    try {
      raw = JSON.parse(await fs.readFile(filename, 'utf8'))
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        (raw.serverUrl !== undefined && typeof raw.serverUrl !== 'string') ||
        (raw.token !== undefined && typeof raw.token !== 'string') ||
        (raw.encryptedToken !== undefined && typeof raw.encryptedToken !== 'string')
      )
        throw new Error('Invalid configuration format')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { serverUrl: DEFAULT_SERVER_URL, token: '' }
      throw new Error(
        'Unable to read saved cloud configuration. Restore or remove cloud-config.json to sign in again.',
        { cause: error },
      )
    }
    const config = { serverUrl: raw.serverUrl || DEFAULT_SERVER_URL, token: '' }
    if (raw.encryptedToken) {
      if (!canEncrypt()) throw new Error('Unlock your system keychain to access the saved sign-in.')
      try {
        config.token = cipher.decryptString(Buffer.from(raw.encryptedToken, 'base64'))
      } catch (error) {
        throw new Error(
          'Saved sign-in could not be decrypted. Remove cloud-config.json and sign in again.',
          { cause: error },
        )
      }
    } else if (raw.token) {
      config.token = raw.token
      await save(config)
    }
    await fs.chmod(filename, 0o600)
    return config
  }
  return { load, save }
}
