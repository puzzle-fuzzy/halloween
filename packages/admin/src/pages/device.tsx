import * as React from "react"
import { useParams } from "react-router-dom"
import { IconCircleCheck, IconDeviceDesktop } from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { adminApi, checkSession } from "@/lib/api"

type Stage = 'checking' | 'need-password' | 'approving' | 'approved' | 'error'

export default function DevicePage() {
  const { code = '' } = useParams()
  const [stage, setStage] = React.useState<Stage>('checking')
  const [password, setPassword] = React.useState('')
  const [error, setError] = React.useState('')

  const approve = React.useCallback(async () => {
    setStage('approving')
    setError('')
    try {
      await adminApi('/device/approve', {
        method: 'POST',
        body: JSON.stringify({ user_code: code }),
      })
      setStage('approved')
    } catch (e) {
      setError(String(e))
      setStage('error')
    }
  }, [code])

  React.useEffect(() => {
    void checkSession().then((ok) => {
      if (ok) void approve()
      else setStage('need-password')
    })
  }, [approve])

  const signInAndApprove = async () => {
    if (!password) return
    setError('')
    try {
      await adminApi('/login', { method: 'POST', body: JSON.stringify({ password }) })
      await approve()
    } catch (e) {
      setError(String(e).includes('wrong password') ? 'Wrong password' : String(e))
    }
  }

  return (
    <div className="bg-muted/40 flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <IconDeviceDesktop className="size-5" />
            Device authorization
          </CardTitle>
          <CardDescription>
            {stage === 'approved'
              ? 'This device has been approved.'
              : 'A desktop app is requesting access. Verify the code shown in the app.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {stage === 'approved' && (
            <p className="flex items-center justify-center gap-2 text-sm">
              <IconCircleCheck className="size-4" />
              Approved — return to the app.
            </p>
          )}
          {stage === 'need-password' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Admin password</Label>
              <Input
                id="password"
                type="password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void signInAndApprove()}
              />
            </div>
          )}
          {(stage === 'checking' || stage === 'approving') && (
            <p className="text-muted-foreground text-center text-sm">Checking…</p>
          )}
          {error && <p className="text-destructive text-sm">{error}</p>}
        </CardContent>
        {stage !== 'approved' && (
          <CardFooter>
            <Button
              className="w-full"
              onClick={() => void (stage === 'need-password' ? signInAndApprove() : approve())}
              disabled={stage === 'checking' || stage === 'approving' || (stage === 'need-password' && !password)}
            >
              {stage === 'approving' ? 'Approving…' : 'Approve device'}
            </Button>
          </CardFooter>
        )}
      </Card>
    </div>
  )
}
