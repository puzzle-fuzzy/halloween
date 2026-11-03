export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function adminApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/admin/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    if (res.status === 401 && !path.startsWith('/login') && !window.location.hash.startsWith('#/device/')) {
      window.location.hash = '#/login'
    }
    throw new ApiError(res.status, (body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export function checkSession(signal?: AbortSignal): Promise<boolean> {
  return fetch('/admin/api/session', { credentials: 'same-origin', signal }).then((r) => {
    if (r.status === 401) return false
    if (!r.ok) throw new ApiError(r.status, `Could not check session (HTTP ${r.status})`)
    return true
  })
}
