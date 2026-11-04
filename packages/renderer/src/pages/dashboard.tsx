import { Badge } from "@halloween/ui/badge"
import { Button } from "@halloween/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@halloween/ui/card"
import { IconArrowRight, IconBucket, IconCloud, IconRefresh } from "@tabler/icons-react"
import * as React from "react"
import { Link } from "react-router-dom"
import { useCloudAuth } from "@/components/cloud/auth"
import { useI18n } from "@/i18n"
import { formatBytes, formatTime } from "@/lib/format"
import type { CloudEntry } from "@/types/global"

interface Overview {
  entries: CloudEntry[]
  accounts: number
}

export default function DashboardPage() {
  const { authed, error: authError, retry, handleError } = useCloudAuth()
  const { t } = useI18n()
  const [overview, setOverview] = React.useState<Overview | null>(null)
  const [error, setError] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [refresh, setRefresh] = React.useState(0)

  React.useEffect(() => {
    let active = true
    setOverview(null)
    setError("")
    if (!authed)
      return () => {
        active = false
      }
    const cloud = window.electron?.cloud
    const oss = window.electron?.oss
    if (!cloud || !oss)
      return () => {
        active = false
      }
    setLoading(true)
    void Promise.all([cloud.list("/"), oss.accounts()])
      .then(([files, accounts]) => {
        if (active) setOverview({ entries: files.entries, accounts: accounts.accounts.length })
      })
      .catch((e: unknown) => {
        if (active) {
          setError(String(e))
          handleError(e)
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [authed, refresh, handleError])

  const recent =
    overview?.entries
      .filter((entry) => entry.type === "file")
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5) ?? []

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 lg:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{t.dashboard.title}</h2>
          <p className="text-muted-foreground mt-2 text-sm">{t.dashboard.subtitle}</p>
        </div>
        <Badge variant="outline">
          {authed === null
            ? t.dashboard.checkingConnection
            : authed
              ? t.dashboard.signedIn
              : t.dashboard.signedOut}
        </Badge>
      </div>

      {authError && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-lg border p-4 text-sm"
        >
          <p className="text-destructive flex-1">{authError}</p>
          {authed === null && (
            <Button variant="outline" size="sm" onClick={() => void retry()}>
              {t.common.retryConnection}
            </Button>
          )}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <IconCloud className="size-5" />
              {t.dashboard.cloudCard}
            </CardTitle>
            <CardDescription>{t.dashboard.cloudCardDesc}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-start gap-4">
            <p className="text-muted-foreground text-sm">
              {overview
                ? t.dashboard.itemsInRoot(overview.entries.length)
                : t.dashboard.cloudFallback}
            </p>
            <Button asChild>
              <Link to="/cloud">
                {authed ? t.dashboard.openCloud : t.dashboard.signInCloud}
                <IconArrowRight />
              </Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <IconBucket className="size-5" />
              {t.dashboard.ossCard}
            </CardTitle>
            <CardDescription>{t.dashboard.ossCardDesc}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-start gap-4">
            <p className="text-muted-foreground text-sm">
              {overview
                ? t.dashboard.accountsConfigured(overview.accounts)
                : t.dashboard.ossFallback}
            </p>
            <Button asChild variant="outline">
              <Link to="/oss">
                {t.dashboard.openOss}
                <IconArrowRight />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      {authed && (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>{t.dashboard.recent}</CardTitle>
              <CardDescription className="mt-2">{t.dashboard.recentDesc}</CardDescription>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t.dashboard.refreshAria}
              disabled={loading}
              onClick={() => setRefresh((n) => n + 1)}
            >
              <IconRefresh className={loading ? "animate-spin" : ""} />
            </Button>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-muted-foreground text-sm">{t.dashboard.loadingStorage}</p>
            ) : error ? (
              <div role="alert" className="space-y-2 text-sm">
                <p className="text-destructive">{t.dashboard.loadFailed}</p>
                <p className="text-muted-foreground break-words">{error}</p>
              </div>
            ) : recent.length ? (
              <ul className="divide-y">
                {recent.map((entry) => (
                  <li
                    key={entry.path}
                    className="flex items-center justify-between gap-4 py-3 text-sm"
                  >
                    <span className="truncate font-medium">{entry.name}</span>
                    <span className="text-muted-foreground shrink-0">
                      {formatBytes(entry.size)} · {formatTime(entry.mtime)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-sm">{t.dashboard.emptyRoot}</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
