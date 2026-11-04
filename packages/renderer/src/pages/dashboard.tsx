import * as React from "react"
import { Link } from "react-router-dom"
import { IconArrowRight, IconBucket, IconCloud, IconRefresh } from "@tabler/icons-react"

import { useCloudAuth } from "@/components/cloud/auth"
import { Badge } from "@halloween/ui/badge"
import { Button } from "@halloween/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@halloween/ui/card"
import { formatBytes, formatTime } from "@/lib/format"
import type { CloudEntry } from "@/types/global"

interface Overview {
  entries: CloudEntry[]
  accounts: number
}

export default function DashboardPage() {
  const { authed, error: authError, retry, handleError } = useCloudAuth()
  const [overview, setOverview] = React.useState<Overview | null>(null)
  const [error, setError] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [refresh, setRefresh] = React.useState(0)

  React.useEffect(() => {
    let active = true
    setOverview(null)
    setError("")
    if (!authed) return () => { active = false }
    const cloud = window.electron?.cloud
    const oss = window.electron?.oss
    if (!cloud || !oss) return () => { active = false }
    setLoading(true)
    void Promise.all([cloud.list("/"), oss.accounts()])
      .then(([files, accounts]) => {
        if (active) setOverview({ entries: files.entries, accounts: accounts.accounts.length })
      })
      .catch((e: unknown) => { if (active) { setError(String(e)); handleError(e) } })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [authed, refresh, handleError])

  const recent = overview?.entries.filter((entry) => entry.type === "file")
    .sort((a, b) => b.mtime - a.mtime).slice(0, 5) ?? []

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 lg:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Your files, in one place</h2>
          <p className="text-muted-foreground mt-2 text-sm">Manage your private cloud drive and OSS storage.</p>
        </div>
        <Badge variant="outline">{authed === null ? "Checking connection…" : authed ? "Signed in" : "Signed out"}</Badge>
      </div>

      {authError && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border p-4 text-sm"><p className="text-destructive flex-1">{authError}</p>{authed === null && <Button variant="outline" size="sm" onClick={() => void retry()}>Retry connection</Button>}</div>}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><IconCloud className="size-5" />Cloud drive</CardTitle>
            <CardDescription>Your files on your own server.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-start gap-4">
            <p className="text-muted-foreground text-sm">
              {overview ? `${overview.entries.length} items in the root folder` : "Browse, search, upload and preview your files."}
            </p>
            <Button asChild><Link to="/cloud">{authed ? "Open cloud drive" : "Sign in to cloud drive"}<IconArrowRight /></Link></Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><IconBucket className="size-5" />OSS storage</CardTitle>
            <CardDescription>Access your Aliyun accounts and buckets.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-start gap-4">
            <p className="text-muted-foreground text-sm">
              {overview ? `${overview.accounts} configured OSS account${overview.accounts === 1 ? "" : "s"}` : "Upload and download directly to your buckets."}
            </p>
            <Button asChild variant="outline"><Link to="/oss">Open OSS manager<IconArrowRight /></Link></Button>
          </CardContent>
        </Card>
      </div>

      {authed && (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>Recently modified in cloud root</CardTitle>
              <CardDescription className="mt-2">Files in subfolders are available in the cloud drive.</CardDescription>
            </div>
            <Button variant="ghost" size="icon" aria-label="Refresh overview" disabled={loading} onClick={() => setRefresh((n) => n + 1)}>
              <IconRefresh className={loading ? "animate-spin" : ""} />
            </Button>
          </CardHeader>
          <CardContent>
            {loading ? <p className="text-muted-foreground text-sm">Loading your storage…</p> : error ? (
              <div role="alert" className="space-y-2 text-sm">
                <p className="text-destructive">Could not load your storage. Check the connection or sign in again.</p>
                <p className="text-muted-foreground break-words">{error}</p>
              </div>
            ) : recent.length ? (
              <ul className="divide-y">
                {recent.map((entry) => (
                  <li key={entry.path} className="flex items-center justify-between gap-4 py-3 text-sm">
                    <span className="truncate font-medium">{entry.name}</span>
                    <span className="text-muted-foreground shrink-0">{formatBytes(entry.size)} · {formatTime(entry.mtime)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-muted-foreground text-sm">No files in the root folder yet.</p>}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
