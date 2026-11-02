import * as React from "react"

interface CloudAuthValue {
  authed: boolean | null
  error: string
  authCode: { userCode: string; expiresAt: number } | null
  signingIn: boolean
  retry: () => Promise<void>
  handleError: (error: unknown) => void
  login: () => Promise<void>
  logout: () => Promise<void>
}

const CloudAuthContext = React.createContext<CloudAuthValue>({
  authed: null,
  error: "",
  authCode: null,
  signingIn: false,
  retry: async () => {},
  handleError: () => {},
  login: async () => {},
  logout: async () => {},
})

export function useCloudAuth() {
  return React.useContext(CloudAuthContext)
}

export function CloudAuthProvider({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = React.useState<boolean | null>(null)
  const [error, setError] = React.useState("")
  const [authCode, setAuthCode] = React.useState<CloudAuthValue["authCode"]>(null)
  const [signingIn, setSigningIn] = React.useState(false)
  const revision = React.useRef(0)
  const loginPromise = React.useRef<Promise<void> | null>(null)

  const retry = React.useCallback(async () => {
    const request = ++revision.current
    setError("")
    try {
      if (!window.electron?.cloud) throw new Error("Open this page in the Halloween desktop app.")
      const valid = await window.electron.cloud.isAuthed()
      if (request === revision.current) setAuthed(valid)
    } catch (e) {
      if (request === revision.current) setError(String(e))
    }
  }, [])

  React.useEffect(() => {
    void retry()
    const unsubscribe = window.electron?.cloud?.onAuthCode((code) => {
      if (loginPromise.current) setAuthCode(code)
    })
    return () => {
      revision.current += 1
      unsubscribe?.()
    }
  }, [retry])

  const handleError = React.useCallback((e: unknown) => {
    if (/HTTP (401|403)|unauthorized|invalid token/i.test(String(e))) {
      revision.current += 1
      setAuthed(false)
      setError("Your device authorization has expired or was revoked. Sign in again.")
    }
  }, [])

  const login = React.useCallback((): Promise<void> => {
    if (loginPromise.current) return loginPromise.current
    const request = ++revision.current
    setSigningIn(true)
    setError("")
    setAuthCode(null)
    const operation = (async () => {
      if (!window.electron?.cloud) throw new Error("The desktop connection is unavailable.")
      await window.electron.cloud.login()
      if (request !== revision.current) throw new Error("Sign-in was cancelled.")
      setAuthed(true)
    })()
    const tracked = operation.finally(() => {
      if (loginPromise.current !== tracked) return
      loginPromise.current = null
      setSigningIn(false)
      setAuthCode(null)
    })
    loginPromise.current = tracked
    return tracked
  }, [])

  const logout = React.useCallback(async () => {
    revision.current += 1
    loginPromise.current = null
    setSigningIn(false)
    setAuthed(false)
    setError("")
    setAuthCode(null)
    await window.electron?.cloud?.logout()
  }, [])

  return (
    <CloudAuthContext.Provider value={{ authed, error, authCode, signingIn, retry, handleError, login, logout }}>
      {children}
    </CloudAuthContext.Provider>
  )
}
