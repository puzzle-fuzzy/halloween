import { Badge } from "@halloween/ui/badge"
import { Button } from "@halloween/ui/button"
import { Checkbox } from "@halloween/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@halloween/ui/dialog"
import { Input } from "@halloween/ui/input"
import { Label } from "@halloween/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@halloween/ui/table"
import { IconPencil, IconPlus, IconRefresh, IconTrash } from "@tabler/icons-react"
import { format } from "date-fns"
import * as React from "react"
import { useI18n } from "@/i18n"
import { adminApi } from "@/lib/api"

interface Feed {
  id: string
  title: string
  url: string
  enabled: boolean
  createdAt: number
  feedTitle: string
  ok: boolean
  count: number
  error: string
  fetchedAt: number
}

interface FeedsResponse {
  refreshedAt: number
  total: number
  feeds: Feed[]
}

interface DialogState {
  mode: "create" | "edit"
  id?: string
  title: string
  url: string
  enabled: boolean
}

const emptyDialog: DialogState = { mode: "create", title: "", url: "", enabled: true }

function feedName(feed: Feed): string {
  return feed.title || feed.feedTitle || feed.url
}

export default function RssPage() {
  const { t } = useI18n()
  const [data, setData] = React.useState<FeedsResponse | null>(null)
  const [dialog, setDialog] = React.useState<DialogState | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState("")

  const load = React.useCallback(async () => {
    try {
      setData(await adminApi<FeedsResponse>("/rss/feeds"))
    } catch {
      window.location.hash = "#/login"
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const refresh = React.useCallback(async () => {
    setRefreshing(true)
    setError("")
    try {
      await adminApi("/rss/refresh", { method: "POST" })
      await load()
    } catch (e) {
      setError(String(e))
    } finally {
      setRefreshing(false)
    }
  }, [load])

  const save = async () => {
    if (!dialog) return
    setError("")
    const body = {
      id: dialog.id,
      title: dialog.title.trim(),
      url: dialog.url.trim(),
      enabled: dialog.enabled,
    }
    try {
      if (dialog.mode === "create") {
        await adminApi("/rss/feeds", { method: "POST", body: JSON.stringify(body) })
        setDialog(null)
        await refresh()
        return
      }
      await adminApi("/rss/feeds/update", { method: "POST", body: JSON.stringify(body) })
      setDialog(null)
      void load()
    } catch (e) {
      setError(String(e))
    }
  }

  const remove = async (feed: Feed) => {
    if (!window.confirm(t.rss.deleteConfirm(feedName(feed)))) return
    await adminApi("/rss/feeds/delete", {
      method: "POST",
      body: JSON.stringify({ id: feed.id }),
    })
    void load()
  }

  return (
    <div className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-muted-foreground flex-1 text-sm">{t.rss.description}</p>
        <span className="text-muted-foreground text-xs">
          {data?.refreshedAt
            ? t.rss.updated(format(new Date(data.refreshedAt), "MMM d, HH:mm"))
            : "—"}
          {data ? ` · ${t.rss.items(data.total)}` : ""}
        </span>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing}>
          <IconRefresh className={refreshing ? "animate-spin" : ""} />
          {t.rss.refreshNow}
        </Button>
        <Button size="sm" onClick={() => setDialog({ ...emptyDialog })}>
          <IconPlus />
          {t.rss.addFeed}
        </Button>
      </div>
      {error && <p className="text-destructive text-sm">{error}</p>}
      <div className="flex-1 overflow-hidden rounded-lg border">
        {data === null ? (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            {t.common.loading}
          </div>
        ) : data.feeds.length === 0 ? (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            {t.rss.empty}
          </div>
        ) : (
          <div className="h-full overflow-auto [scrollbar-gutter:stable]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-3">{t.rss.feed}</TableHead>
                  <TableHead className="w-28">{t.rss.status}</TableHead>
                  <TableHead className="w-44">{t.rss.fetched}</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.feeds.map((feed) => (
                  <TableRow key={feed.id} className={feed.enabled ? undefined : "opacity-60"}>
                    <TableCell className="max-w-0 pl-3">
                      <p className="truncate font-medium">{feedName(feed)}</p>
                      <p className="text-muted-foreground truncate text-xs">{feed.url}</p>
                    </TableCell>
                    <TableCell>
                      {!feed.enabled ? (
                        <Badge variant="outline">{t.rss.disabled}</Badge>
                      ) : feed.fetchedAt === 0 ? (
                        <Badge variant="outline">{t.rss.pending}</Badge>
                      ) : feed.ok ? (
                        <Badge variant="secondary">{t.rss.itemCount(feed.count)}</Badge>
                      ) : (
                        <Badge variant="destructive" title={feed.error}>
                          {t.rss.error}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {feed.fetchedAt ? format(new Date(feed.fetchedAt), "MMM d, HH:mm") : "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label={t.common.edit}
                          onClick={() =>
                            setDialog({
                              mode: "edit",
                              id: feed.id,
                              title: feed.title,
                              url: feed.url,
                              enabled: feed.enabled,
                            })
                          }
                        >
                          <IconPencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive size-7"
                          aria-label={t.common.delete}
                          onClick={() => void remove(feed)}
                        >
                          <IconTrash className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <Dialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {dialog?.mode === "create" ? t.rss.addTitle : t.rss.editTitle}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="rss-title">{t.rss.title}</Label>
              <Input
                id="rss-title"
                placeholder={t.rss.titlePlaceholder}
                value={dialog?.title ?? ""}
                onChange={(e) => dialog && setDialog({ ...dialog, title: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rss-url">{t.rss.url}</Label>
              <Input
                id="rss-url"
                type="url"
                placeholder="https://example.com/feed.xml"
                value={dialog?.url ?? ""}
                onChange={(e) => dialog && setDialog({ ...dialog, url: e.target.value })}
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="rss-enabled"
                checked={dialog?.enabled ?? true}
                onCheckedChange={(v) => dialog && setDialog({ ...dialog, enabled: v === true })}
              />
              <Label htmlFor="rss-enabled">{t.rss.enabled}</Label>
            </div>
            {error && <p className="text-destructive text-sm">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              {t.common.cancel}
            </Button>
            <Button
              onClick={() => void save()}
              disabled={
                !dialog?.url.trim() ||
                (!dialog.url.startsWith("http://") && !dialog.url.startsWith("https://"))
              }
            >
              {dialog?.mode === "create" ? t.common.add : t.common.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
