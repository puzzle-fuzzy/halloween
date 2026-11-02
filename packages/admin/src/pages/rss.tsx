import * as React from "react"
import { format } from "date-fns"
import { IconPencil, IconPlus, IconRefresh, IconTrash } from "@tabler/icons-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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
  const [data, setData] = React.useState<FeedsResponse | null>(null)
  const [dialog, setDialog] = React.useState<DialogState | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState("")

  const load = React.useCallback(async () => {
    try {
      setData(await adminApi<FeedsResponse>('/rss/feeds'))
    } catch {
      window.location.hash = '#/login'
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const refresh = React.useCallback(async () => {
    setRefreshing(true)
    setError("")
    try {
      await adminApi('/rss/refresh', { method: 'POST' })
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
        await adminApi('/rss/feeds', { method: 'POST', body: JSON.stringify(body) })
        setDialog(null)
        await refresh()
        return
      }
      await adminApi('/rss/feeds/update', { method: 'POST', body: JSON.stringify(body) })
      setDialog(null)
      void load()
    } catch (e) {
      setError(String(e))
    }
  }

  const remove = async (feed: Feed) => {
    if (!window.confirm(`Delete feed "${feedName(feed)}"?`)) return
    await adminApi('/rss/feeds/delete', {
      method: 'POST',
      body: JSON.stringify({ id: feed.id }),
    })
    void load()
  }

  return (
    <div className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-muted-foreground flex-1 text-sm">
          RSS sources — the server refreshes them every 30 minutes and caches the
          items for the desktop app.
        </p>
        <span className="text-muted-foreground text-xs">
          Updated {data?.refreshedAt ? format(new Date(data.refreshedAt), 'MMM d, HH:mm') : '—'}
          {data ? ` · ${data.total} items` : ''}
        </span>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing}>
          <IconRefresh className={refreshing ? 'animate-spin' : ''} />
          Refresh Now
        </Button>
        <Button size="sm" onClick={() => setDialog({ ...emptyDialog })}>
          <IconPlus />
          Add Feed
        </Button>
      </div>
      {error && <p className="text-destructive text-sm">{error}</p>}
      <div className="flex-1 overflow-hidden rounded-lg border">
        {data === null ? (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            Loading…
          </div>
        ) : data.feeds.length === 0 ? (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            No RSS feeds configured
          </div>
        ) : (
          <div className="h-full overflow-auto [scrollbar-gutter:stable]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-3">Feed</TableHead>
                  <TableHead className="w-28">Status</TableHead>
                  <TableHead className="w-44">Fetched</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.feeds.map((feed) => (
                  <TableRow key={feed.id} className={feed.enabled ? undefined : 'opacity-60'}>
                    <TableCell className="max-w-0 pl-3">
                      <p className="truncate font-medium">{feedName(feed)}</p>
                      <p className="text-muted-foreground truncate text-xs">{feed.url}</p>
                    </TableCell>
                    <TableCell>
                      {!feed.enabled ? (
                        <Badge variant="outline">Disabled</Badge>
                      ) : feed.fetchedAt === 0 ? (
                        <Badge variant="outline">Pending</Badge>
                      ) : feed.ok ? (
                        <Badge variant="secondary">{feed.count} items</Badge>
                      ) : (
                        <Badge variant="destructive" title={feed.error}>
                          Error
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {feed.fetchedAt ? format(new Date(feed.fetchedAt), 'MMM d, HH:mm') : '—'}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label="Edit"
                          onClick={() =>
                            setDialog({
                              mode: 'edit',
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
                          aria-label="Delete"
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
            <DialogTitle>{dialog?.mode === 'create' ? 'Add RSS Feed' : 'Edit RSS Feed'}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="rss-title">Title</Label>
              <Input
                id="rss-title"
                placeholder="leave blank to use the feed's own title"
                value={dialog?.title ?? ''}
                onChange={(e) => dialog && setDialog({ ...dialog, title: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rss-url">Feed URL</Label>
              <Input
                id="rss-url"
                type="url"
                placeholder="https://example.com/feed.xml"
                value={dialog?.url ?? ''}
                onChange={(e) => dialog && setDialog({ ...dialog, url: e.target.value })}
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="rss-enabled"
                checked={dialog?.enabled ?? true}
                onCheckedChange={(v) => dialog && setDialog({ ...dialog, enabled: v === true })}
              />
              <Label htmlFor="rss-enabled">Enabled</Label>
            </div>
            {error && <p className="text-destructive text-sm">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => void save()}
              disabled={!dialog?.url.trim() || (!dialog.url.startsWith('http://') && !dialog.url.startsWith('https://'))}
            >
              {dialog?.mode === 'create' ? 'Add' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
