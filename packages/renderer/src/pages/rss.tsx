import * as React from "react"
import { IconExternalLink, IconRefresh } from "@tabler/icons-react"

import { useCloudAuth } from "@/components/cloud/auth"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { formatTime } from "@/lib/format"
import type { RssItem } from "@/types/global"

const ADMIN_RSS_URL = "https://halloween.yxswy.com/admin/#/rss"

function openLink(url: string) {
  const api = window.electron?.rss
  if (api) void api.open(url)
  else window.open(url, "_blank")
}

export default function RssPage() {
  const { authed, login } = useCloudAuth()
  const rss = window.electron?.rss
  const [signingIn, setSigningIn] = React.useState(false)
  const [signInError, setSignInError] = React.useState("")

  const [data, setData] = React.useState<{ refreshedAt: number; items: RssItem[] } | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState("")
  const [feed, setFeed] = React.useState("all")

  const load = React.useCallback(async () => {
    if (!rss) return
    setLoading(true)
    setError("")
    try {
      setData(await rss.items(100))
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [rss])

  React.useEffect(() => {
    if (authed) void load()
  }, [authed, load])

  const startSignIn = async () => {
    if (signingIn) return
    setSigningIn(true)
    setSignInError("")
    try {
      await login()
    } catch (e) {
      setSignInError(String(e))
    } finally {
      setSigningIn(false)
    }
  }

  if (authed === null || authed === false) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        {authed === null ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : (
          <>
            <p className="text-sm">Sign in to read RSS feeds</p>
            {signingIn ? (
              <p className="text-muted-foreground flex items-center gap-2 text-sm">
                <IconRefresh className="size-4 animate-spin" />
                Complete the authorization in your browser…
              </p>
            ) : (
              <Button size="sm" onClick={() => void startSignIn()}>
                Sign in with browser
              </Button>
            )}
            {signInError && <p className="text-destructive text-sm">{signInError}</p>}
          </>
        )}
      </div>
    )
  }

  const items = data?.items ?? []
  const feedNames = Array.from(new Set(items.map((it) => it.feedTitle)))
  const visible = feed === "all" ? items : items.filter((it) => it.feedTitle === feed)

  return (
    <div className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:px-6">
      <div className="flex flex-wrap items-center gap-2">
        {feedNames.length > 1 && (
          <Select value={feed} onValueChange={setFeed}>
            <SelectTrigger size="sm" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {feedNames.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <span className="text-muted-foreground ml-auto text-xs">
          Updated {data?.refreshedAt ? formatTime(data.refreshedAt) : "—"}
        </span>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <IconRefresh className={loading ? "animate-spin" : ""} />
          Refresh
        </Button>
      </div>

      <div className="flex-1 overflow-hidden">
        <div className="h-full overflow-auto [scrollbar-gutter:stable]">
        {loading && items.length === 0 ? (
          <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
            <IconRefresh className="size-4 animate-spin" />
            Loading…
          </div>
        ) : error && items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <p className="text-destructive text-sm">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <p className="text-muted-foreground text-sm">
              No RSS items yet — feeds are configured in the admin console
            </p>
            <Button variant="outline" size="sm" onClick={() => window.open(ADMIN_RSS_URL, "_blank")}>
              <IconExternalLink />
              Open Admin Console
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3 pb-1">
            {visible.map((item) => (
              <Card key={item.id} className="gap-0 py-4">
                <CardContent className="flex flex-col gap-1.5 px-4">
                  <div className="flex items-start gap-3">
                    <button
                      className="min-w-0 flex-1 text-left"
                      onClick={() => openLink(item.link)}
                      disabled={!item.link}
                    >
                      <span className="font-medium hover:underline">
                        {item.title || item.link}
                      </span>
                    </button>
                    <Badge variant="secondary" className="max-w-40 shrink-0 truncate">
                      {item.feedTitle}
                    </Badge>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {formatTime(item.publishedAt)}
                    </span>
                  </div>
                  {item.summary && (
                    <p className="text-muted-foreground line-clamp-2 text-sm">{item.summary}</p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
        </div>
      </div>
    </div>
  )
}
