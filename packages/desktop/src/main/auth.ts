import type { CloudConfig } from './config-store'

export class SignInAttempt {
  private active?: { controller: AbortController; promise: Promise<{ ok: boolean }> }
  private resetting?: Promise<void>
  run(task: (signal: AbortSignal) => Promise<{ ok: boolean }>): Promise<{ ok: boolean }> {
    if (this.resetting) return this.resetting.then(() => this.run(task))
    if (this.active) return this.active.promise
    const controller = new AbortController()
    const promise = Promise.resolve()
      .then(() => task(controller.signal))
      .finally(() => {
        if (this.active?.controller === controller) this.active = undefined
      })
    this.active = { controller, promise }
    return promise
  }
  cancel(after: () => Promise<void> = async () => {}): Promise<void> {
    if (this.resetting) return this.resetting
    const active = this.active
    active?.controller.abort(new DOMException('Sign-in cancelled', 'AbortError'))
    this.resetting = (async () => {
      await active?.promise.catch(() => {})
      await after()
    })().finally(() => {
      this.resetting = undefined
    })
    return this.resetting
  }
}

/** Only an explicit rejection invalidates a local sign-in; network errors remain retryable. */
export async function verifySignIn(
  config: CloudConfig,
  request: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<boolean> {
  if (!config.token) return false
  const response = await request(`${config.serverUrl}/api/profile`, {
    headers: { Authorization: `Bearer ${config.token}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 401 || response.status === 403) return false
  if (!response.ok) throw new Error(`Unable to verify sign-in (HTTP ${response.status})`)
  return true
}

export function parseDevicePoll(
  status: number,
  result?: { status: string; token?: string },
): string | null {
  if (status === 410) throw new Error('Sign-in expired, please try again')
  if (status === 403 || result?.status === 'denied') throw new Error('Sign-in was denied')
  if (status < 200 || status >= 300) throw new Error(`Unable to check sign-in (HTTP ${status})`)
  if (result?.status === 'approved' && result.token) return result.token
  if (result?.status === 'pending') return null
  throw new Error('The server returned an invalid sign-in response')
}
