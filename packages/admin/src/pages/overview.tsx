import * as React from "react"
import { format } from "date-fns"
import prettyBytes from "pretty-bytes"
import { Navigate } from "react-router-dom"

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { adminApi, checkSession } from "@/lib/api"

interface Stats {
  storage: { total: number; available: number; used: number }
  devices: number
}

function StatCard({
  title,
  value,
  hint,
}: {
  title: string
  value: React.ReactNode
  hint: string
}) {
  return (
    <Card className="@container/card">
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
          {value}
        </CardTitle>
      </CardHeader>
      <CardFooter className="text-muted-foreground text-sm">{hint}</CardFooter>
    </Card>
  )
}

export default function OverviewPage() {
  const [authed, setAuthed] = React.useState<boolean | null>(null)
  const [stats, setStats] = React.useState<Stats | null>(null)
  const [error, setError] = React.useState('')
  const [attempt, setAttempt] = React.useState(0)

  React.useEffect(() => {
    const controller = new AbortController()
    setError('')
    void checkSession(controller.signal)
      .then(async (ok) => {
        if (controller.signal.aborted) return
        setAuthed(ok)
        if (ok) {
          const result = await adminApi<Stats>('/stats', { signal: controller.signal })
          if (!controller.signal.aborted) setStats(result)
        }
      })
      .catch((e: unknown) => { if (!controller.signal.aborted) setError(String(e)) })
    return () => controller.abort()
  }, [attempt])

  if (authed === false) return <Navigate to="/login" replace />
  if (error) return <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6"><p role="alert" className="text-destructive text-sm">{error}</p><Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>Retry</Button></div>
  if (authed === null || !stats) {
    return (
      <div className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:px-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-36 rounded-lg" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:px-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          title="Data volume used"
          value={prettyBytes(stats.storage.used)}
          hint={`${prettyBytes(stats.storage.total)} total, including other files on this volume`}
        />
        <StatCard
          title="Storage available"
          value={prettyBytes(stats.storage.available)}
          hint="Free space on the data volume"
        />
        <StatCard
          title="Devices"
          value={stats.devices}
          hint="Authorized desktop devices"
        />
      </div>
      <Card className="@container/card">
        <CardHeader>
          <CardTitle>Your storage</CardTitle>
          <CardDescription>
            Manage your authorized devices, OSS accounts and personal profile from the sidebar.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground flex items-center gap-2 text-sm">
          {format(new Date(), 'EEEE, MMM d yyyy')}
        </CardContent>
      </Card>
    </div>
  )
}
