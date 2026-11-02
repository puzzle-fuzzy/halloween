import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dir, '..')
const filename = path.join(root, 'packages/server/.env')
const data = path.join(root, '.local-data')
await fs.mkdir(data, { recursive: true, mode: 0o700 })
const contents = [
  'PORT=3690',
  `DATA_ROOT=${JSON.stringify(path.join(data, 'files'))}`,
  `STATE_ROOT=${JSON.stringify(path.join(data, 'state'))}`,
  `TOKEN=${randomBytes(32).toString('hex')}`,
  `ADMIN_PASSWORD=${randomBytes(24).toString('hex')}`,
  'PUBLIC_ORIGIN=http://127.0.0.1:3690',
  '',
].join('\n')
try {
  await fs.writeFile(filename, contents, { flag: 'wx', mode: 0o600 })
  console.log('Created packages/server/.env with separate local storage and random credentials.')
  console.log('Read ADMIN_PASSWORD from that file to sign in to the local admin console.')
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  console.log('packages/server/.env already exists; left it unchanged.')
}
