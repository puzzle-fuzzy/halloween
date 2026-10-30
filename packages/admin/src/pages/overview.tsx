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

  React.useEffect(() => {
    void checkSession()
      .then(async (ok) => {
        setAuthed(ok)
        if (ok) setStats(await adminApi<Stats>('/stats'))
      })
      .catch(() => setAuthed(false))
  }, [])

  if (authed === false) return <Navigate to="/login" replace />
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
          title="Storage used"
          value={prettyBytes(stats.storage.used)}
          hint={`${prettyBytes(stats.storage.total)} total`}
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
          <CardTitle>halloween.yxswy.com</CardTitle>
          <CardDescription>
            Cloud drive serves at <code>/cloud</code>; every future service gets its own prefix on
            this domain.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground flex items-center gap-2 text-sm">
          {format(new Date(), 'EEEE, MMM d yyyy')}
        </CardContent>
      </Card>
    </div>
  )
}
