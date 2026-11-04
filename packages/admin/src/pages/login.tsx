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
import { useI18n } from "@/i18n"

export default function LoginPage() {
  const navigate = useNavigate()
  const { t } = useI18n()
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
      setError(String(e).includes('wrong password') ? t.login.wrongPassword : String(e))
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
            {t.login.title}
          </CardTitle>
          <CardDescription>{t.login.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">{t.login.password}</Label>
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
            {busy ? t.login.signingIn : t.login.signIn}
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}
