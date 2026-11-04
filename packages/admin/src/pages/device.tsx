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
import { IconCircleCheck, IconDeviceDesktop } from "@tabler/icons-react"
import * as React from "react"
import { useParams } from "react-router-dom"
import { useI18n } from "@/i18n"
import { adminApi, checkSession } from "@/lib/api"

interface DeviceRequest {
  name: string
  userCode: string
  expiresAt: number
  status: "pending" | "approved" | "denied"
}
type Stage = "checking" | "need-password" | "ready" | "submitting" | "approved" | "denied" | "error"

export default function DevicePage() {
  const { code = "" } = useParams()
  const { t } = useI18n()
  const [stage, setStage] = React.useState<Stage>("checking")
  const [device, setDevice] = React.useState<DeviceRequest | null>(null)
  const [password, setPassword] = React.useState("")
  const [error, setError] = React.useState("")
  const [now, setNow] = React.useState(Date.now())
  const [attempt, setAttempt] = React.useState(0)
  const operation = React.useRef(0)
  const activeCode = React.useRef(code)
  activeCode.current = code

  React.useEffect(() => {
    operation.current += 1
    const controller = new AbortController()
    setStage("checking")
    setDevice(null)
    setError("")
    void (async () => {
      if (!/^\d{6}$/.test(code)) throw new Error(t.device.invalidCode)
      if (!(await checkSession(controller.signal))) {
        if (!controller.signal.aborted) setStage("need-password")
        return
      }
      const request = await adminApi<DeviceRequest>(`/device/${encodeURIComponent(code)}`, {
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      setDevice(request)
      setStage(request.status === "pending" ? "ready" : request.status)
      setNow(Date.now())
    })().catch((e: unknown) => {
      if (!controller.signal.aborted) {
        setError(String(e))
        setStage("error")
      }
    })
    return () => {
      controller.abort()
      operation.current += 1
    }
  }, [code, attempt, t.device.invalidCode]) // attempt: manual re-check token

  React.useEffect(() => {
    if (stage !== "ready") return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [stage])

  const signIn = async () => {
    if (!password || stage !== "need-password") return
    setStage("submitting")
    setError("")
    const version = operation.current
    try {
      await adminApi("/login", { method: "POST", body: JSON.stringify({ password }) })
      if (version !== operation.current || activeCode.current !== code) return
      setPassword("")
      setAttempt((n) => n + 1)
    } catch (e) {
      if (version !== operation.current || activeCode.current !== code) return
      setError(String(e))
      setStage("need-password")
    }
  }

  const decide = async (decision: "approve" | "deny") => {
    if (stage !== "ready" || !device || device.expiresAt <= Date.now()) return
    setStage("submitting")
    setError("")
    const version = operation.current
    try {
      await adminApi(`/device/${decision}`, {
        method: "POST",
        body: JSON.stringify({ user_code: code }),
      })
      if (version !== operation.current || activeCode.current !== code) return
      setStage(decision === "approve" ? "approved" : "denied")
    } catch (e) {
      if (version !== operation.current || activeCode.current !== code) return
      setError(String(e))
      setStage("error")
    }
  }

  const expired = Boolean(device && device.expiresAt <= now)
  return (
    <div className="bg-muted/40 flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <IconDeviceDesktop className="size-5" />
            {t.device.title}
          </CardTitle>
          <CardDescription>{t.device.description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {stage === "approved" ? (
            <p className="flex items-center gap-2 text-sm">
              <IconCircleCheck className="size-4" />
              {t.device.approved}
            </p>
          ) : stage === "denied" ? (
            <p className="text-sm">{t.device.denied}</p>
          ) : (
            <>
              <div className="bg-muted rounded-lg p-4 text-center">
                <p className="text-muted-foreground text-xs">{t.device.code}</p>
                <p className="mt-2 font-mono text-3xl tracking-widest">{code}</p>
              </div>
              {device && (
                <div className="space-y-2 text-sm">
                  <p>
                    {t.device.deviceLabel} <strong className="break-all">{device.name}</strong>
                  </p>
                  <p className="text-muted-foreground">
                    {expired
                      ? t.device.expired
                      : t.device.expiresAt(new Date(device.expiresAt).toLocaleTimeString())}
                  </p>
                  <p>{t.device.compareHint}</p>
                </div>
              )}
            </>
          )}
          {stage === "need-password" && (
            <form
              id="device-sign-in"
              onSubmit={(e) => {
                e.preventDefault()
                void signIn()
              }}
              className="flex flex-col gap-2"
            >
              <Label htmlFor="password">{t.device.adminPassword}</Label>
              <Input
                id="password"
                type="password"
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </form>
          )}
          {(stage === "checking" || stage === "submitting") && (
            <p className="text-muted-foreground text-sm">{t.device.pleaseWait}</p>
          )}
          {error && (
            <p role="alert" className="text-destructive break-words text-sm">
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter className="gap-2">
          {stage === "need-password" && (
            <Button className="w-full" type="submit" form="device-sign-in" disabled={!password}>
              {t.device.signInToReview}
            </Button>
          )}
          {stage === "ready" && !expired && (
            <>
              <Button variant="outline" className="flex-1" onClick={() => void decide("deny")}>
                {t.device.deny}
              </Button>
              <Button className="flex-1" onClick={() => void decide("approve")}>
                {t.device.approve}
              </Button>
            </>
          )}
          {stage === "error" && (
            <Button variant="outline" className="w-full" onClick={() => setAttempt((n) => n + 1)}>
              {t.device.checkAgain}
            </Button>
          )}
        </CardFooter>
      </Card>
    </div>
  )
}
