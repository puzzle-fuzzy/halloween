import * as React from "react"
import { useNavigate } from "react-router-dom"
import { IconShieldHalf } from "@tabler/icons-react"

import { Button } from "@halloween/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@halloween/ui/card"
import { Input } from "@halloween/ui/input"
import { Label } from "@halloween/ui/label"
import { adminApi } from "@/lib/api"

export default function LoginPage() {
  const navigate = useNavigate()
  const [password, setPassword] = React.useState("")
  const [error, setError] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  const submit = async () => {
    if (!password || busy) return
    setBusy(true)
    setError("")
    try {
      await adminApi('/login', { method: 'POST', body: JSON.stringify({ password }) })
      navigate('/', { replace: true })
    } catch (e) {
      setError(String(e).includes('wrong password') ? 'Wrong password' : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-muted/40 flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <IconShieldHalf className="size-5" />
            Halloween Admin
          </CardTitle>
          <CardDescription>Enter the admin password to continue</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
            />
            {error && <p className="text-destructive text-sm">{error}</p>}
          </div>
        </CardContent>
        <CardFooter>
          <Button className="w-full" onClick={() => void submit()} disabled={!password || busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}
