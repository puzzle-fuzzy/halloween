import { execFile } from 'node:child_process'
import { binaryPath, workRoot } from './config'

// TUN needs an elevated process. Instead of a broker service, a scheduled
// task registered once with UAC runs mihomo with the admin token; starting
// and ending your own task needs no further elevation.

export const TASK_NAME = 'HalloweenTunCore'

function schtasks(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('schtasks', args, { windowsHide: true }, (err, stdout) =>
      err ? reject(new Error(String(stdout || err.message).trim())) : resolve(String(stdout))
    )
  })
}

export async function taskExists(): Promise<boolean> {
  if (process.platform !== 'win32') return false
  try {
    await schtasks(['/Query', '/TN', TASK_NAME])
    return true
  } catch {
    return false
  }
}

/** one UAC prompt; registers the elevated on-demand task */
export async function installTunTask(): Promise<void> {
  const create = [
    '/Create', '/TN', TASK_NAME,
    '/TR', `"${binaryPath()}" -d "${workRoot()}"`,
    '/SC', 'ONCE', '/ST', '00:00', '/RL', 'HIGHEST', '/IT', '/F',
  ]
  // schtasks itself must run elevated — launch it through a UAC-elevated PowerShell
  const ps = `Start-Process -FilePath schtasks -ArgumentList @(${create
    .map((a) => `'${a.replace(/'/g, "''")}'`)
    .join(',')}) -Verb RunAs -Wait -PassThru | ForEach-Object { exit $_.ExitCode }`
  await new Promise<void>((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true }, (err, _o, stderr) => {
      if (err) {
        // a declined UAC dialog surfaces here as a canceled Start-Process
        reject(new Error(String(stderr || err.message).trim() || 'elevation declined'))
      } else {
        resolve()
      }
    })
  })
  if (!(await taskExists())) throw new Error('task was not registered')
}

export async function runTunTask(): Promise<void> {
  await schtasks(['/Run', '/TN', TASK_NAME])
}

export async function endTunTask(): Promise<void> {
  try {
    await schtasks(['/End', '/TN', TASK_NAME])
  } catch {
    // task not running — nothing to end
  }
}
