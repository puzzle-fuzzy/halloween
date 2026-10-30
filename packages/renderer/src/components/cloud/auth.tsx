import * as React from "react"

interface CloudAuthValue {
  authed: boolean | null
  login: () => Promise<void>
  logout: () => Promise<void>
}

const CloudAuthContext = React.createContext<CloudAuthValue>({
  authed: null,
  login: async () => {},
  logout: async () => {},
})

export function useCloudAuth() {
  return React.useContext(CloudAuthContext)
}

export function CloudAuthProvider({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = React.useState<boolean | null>(null)

  React.useEffect(() => {
    void window.electron?.cloud?.isAuthed().then(setAuthed)
  }, [])

  const login = React.useCallback(async () => {
    await window.electron?.cloud?.login()
    setAuthed(true)
  }, [])

  const logout = React.useCallback(async () => {
    await window.electron?.cloud?.logout()
    setAuthed(false)
  }, [])

  return (
    <CloudAuthContext.Provider value={{ authed, login, logout }}>
      {children}
    </CloudAuthContext.Provider>
  )
}
