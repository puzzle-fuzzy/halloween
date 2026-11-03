import * as React from "react"
import {
  IconArrowLeft,
  IconChevronRight,
  IconDots,
  IconDownload,
  IconExternalLink,
  IconFile,
  IconFileZip,
  IconFolder,
  IconFolderPlus,
  IconMusic,
  IconPhoto,
  IconRefresh,
  IconUpload,
  IconVideo,
} from "@tabler/icons-react"
import { toast } from "sonner"

import { useCloudAuth } from "@/components/cloud/auth"
import { MediaPreview } from "@/components/cloud/media-preview"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { fileKind, formatBytes, formatTime } from "@/lib/format"
import { createRequestTracker, fileOperationError, isTransferCancelled, mergeEntries, selectVisibleKeys } from "@/lib/file-operations"
import type { OssAccountInfo, OssBucketInfo, OssEntry } from "@/types/global"

const LAST_ACCOUNT_KEY = "oss:lastAccount"
const LAST_BUCKET_KEY = "oss:lastBucket"

function entryIcon(entry: OssEntry) {
  if (entry.type === "dir") return <IconFolder className="text-muted-foreground size-4 shrink-0" />
  const kind = fileKind(entry.name)
  const cls = "text-muted-foreground size-4 shrink-0"
  if (kind === "image") return <IconPhoto className={cls} />
  if (kind === "video") return <IconVideo className={cls} />
  if (kind === "audio") return <IconMusic className={cls} />
  if (kind === "archive") return <IconFileZip className={cls} />
  return <IconFile className={cls} />
}

interface PromptState {
  mode: "mkdir" | "rename"
  value: string
  target?: OssEntry
}

export default function OssManagerPage() {
  const { authed, login, error: authError, retry, authCode, signingIn, handleError } = useCloudAuth()
  const oss = window.electron?.oss
  const cloud = window.electron?.cloud
  const [signInError, setSignInError] = React.useState("")
  const [accounts, setAccounts] = React.useState<OssAccountInfo[] | null>(null)
  const [accountId, setAccountId] = React.useState("")
  const [buckets, setBuckets] = React.useState<OssBucketInfo[]>([])
  const [bucket, setBucket] = React.useState("")
  const [prefix, setPrefix] = React.useState("")
  const [entries, setEntries] = React.useState<OssEntry[]>([])
  const [loading, setLoading] = React.useState(false)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [working, setWorking] = React.useState(false)
  const [nextMarker, setNextMarker] = React.useState<string | undefined>()
  const [truncated, setTruncated] = React.useState(false)
  const [error, setError] = React.useState("")
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [searchInput, setSearchInput] = React.useState("")
  const [dragOver, setDragOver] = React.useState(false)
  const [prompt, setPrompt] = React.useState<PromptState | null>(null)
  const [preview, setPreview] = React.useState<{ name: string; key: string; url: string; scope: string } | null>(null)
  const objectRequests = React.useRef(createRequestTracker()).current
  const bucketRequests = React.useRef(createRequestTracker()).current
  const scope = `${accountId}\0${bucket}\0${prefix}`
  const scopeRef = React.useRef(scope)
  scopeRef.current = scope
  const busy = loading || loadingMore || working

  const reportError = React.useCallback((e: unknown) => {
    if (isTransferCancelled(e)) { toast.info("Transfer cancelled"); return }
    handleError(e)
    toast.error(fileOperationError(e))
  }, [handleError])

  React.useEffect(() => {
    if (!authed) {
      setAccounts(null)
      setAccountId("")
      setBucket("")
      setBuckets([])
      setPrefix("")
      setEntries([])
      setSelected(new Set())
      return
    }
    let active = true
    oss?.accounts().then((res) => {
      if (!active) return
      setAccounts(res.accounts)
      const saved = localStorage.getItem(LAST_ACCOUNT_KEY)
      setAccountId(saved && res.accounts.some((a) => a.id === saved) ? saved : (res.accounts[0]?.id ?? ""))
    }).catch((e) => {
      if (!active) return
      setAccounts([])
      reportError(e)
    })
    return () => { active = false }
  }, [oss, authed, reportError])

  React.useEffect(() => {
    if (!authed || !accountId) return
    const request = bucketRequests.start()
    oss?.buckets(accountId).then((res) => {
      if (!bucketRequests.isCurrent(request)) return
      setBuckets(res.buckets)
      const saved = localStorage.getItem(LAST_BUCKET_KEY)
      setBucket(saved && res.buckets.some((b) => b.name === saved) ? saved : (res.buckets[0]?.name ?? ""))
    }).catch((e) => {
      if (bucketRequests.isCurrent(request)) {
        setError(fileOperationError(e))
        reportError(e)
      }
    })
    return () => bucketRequests.invalidate()
  }, [accountId, authed, oss, bucketRequests, reportError])

  const loadPage = React.useCallback(async (marker?: string) => {
    if (!authed || !oss || !accountId || !bucket) return
    const request = objectRequests.start()
    if (marker) setLoadingMore(true)
    else {
      setLoading(true)
      setEntries([])
      setSelected(new Set())
      setTruncated(false)
      setNextMarker(undefined)
    }
    setError("")
    try {
      const res = await oss.objects(accountId, bucket, prefix, marker)
      if (!objectRequests.isCurrent(request)) return
      setEntries((previous) => marker ? mergeEntries(previous, res.entries) : res.entries)
      setTruncated(res.truncated)
      setNextMarker(res.nextMarker)
    } catch (e) {
      if (!objectRequests.isCurrent(request)) return
      setError(fileOperationError(e))
      reportError(e)
    } finally {
      if (objectRequests.isCurrent(request)) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [oss, accountId, bucket, prefix, authed, objectRequests, reportError])

  React.useEffect(() => {
    void loadPage()
    return () => objectRequests.invalidate()
  }, [loadPage, objectRequests])

  const clearListing = () => {
    objectRequests.invalidate()
    setEntries([])
    setSelected(new Set())
    setNextMarker(undefined)
    setTruncated(false)
    setLoading(false)
    setLoadingMore(false)
    setSearchInput("")
    setError("")
    setPrompt(null)
    setPreview(null)
  }

  const navigate = (nextPrefix: string) => {
    if (nextPrefix === prefix) {
      setSearchInput("")
      void loadPage()
      return
    }
    clearListing()
    setPrefix(nextPrefix)
  }

  const selectedEntries = entries.filter((entry) => selected.has(entry.key))
  const filter = searchInput.trim().toLowerCase()
  const visible = filter ? entries.filter((entry) => entry.name.toLowerCase().includes(filter)) : entries
  const allSelected = visible.length > 0 && visible.every((entry) => selected.has(entry.key))

  const upload = async (localPaths?: string[]) => {
    if (!oss || !accountId || !bucket || busy) return
    const target = scope
    setWorking(true)
    try {
      const uploaded = localPaths?.length
        ? await oss.uploadFiles(accountId, bucket, prefix, localPaths)
        : await oss.pickAndUpload(accountId, bucket, prefix)
      if (!uploaded?.length) return
      toast.success("Upload complete")
      if (scopeRef.current === target) void loadPage()
    } catch (e) { reportError(e) }
    finally { setWorking(false) }
  }

  const download = async (list: OssEntry[]) => {
    const files = list.filter((entry) => entry.type === "file")
    if (!files.length || !oss || !cloud || busy) return
    try {
      const dir = await cloud.chooseDownloadDir()
      if (!dir) return
      for (const file of files) await oss.downloadTo(accountId, bucket, file.key, file.name, dir)
      toast.success(`Saved to ${dir}`)
    } catch (e) { reportError(e) }
  }

  const remove = async (list: OssEntry[]) => {
    if (!oss || !list.length || busy) return
    const includesFolders = list.some((entry) => entry.type === "dir")
    if (!window.confirm(`Permanently delete ${list.length} item${list.length > 1 ? "s" : ""}?${includesFolders ? " All files and subfolders inside selected folders will also be deleted." : ""} This cannot be undone.`)) return
    const target = scope
    setWorking(true)
    try {
      await oss.remove(accountId, bucket, list.map((entry) => entry.key))
      if (scopeRef.current === target) void loadPage()
    } catch (e) { reportError(e) }
    finally { setWorking(false) }
  }

  const onEntryClick = (entry: OssEntry) => {
    if (busy) return
    if (entry.type === "dir") { navigate(entry.key); return }
    const kind = fileKind(entry.name)
    if (kind === "image" || kind === "video" || kind === "audio") {
      const target = scope
      void oss?.previewUrl(accountId, bucket, entry.key).then(({ url }) => {
        if (scopeRef.current === target) setPreview({ name: entry.name, key: entry.key, url, scope: target })
      }).catch(reportError)
    } else void download([entry])
  }

  const submitPrompt = async () => {
    if (!prompt || !oss || busy) return
    const value = prompt.value.trim()
    if (!value) return
    if (/[/\\]/.test(value) || value === "." || value === "..") {
      toast.error("Enter a name without path separators.")
      return
    }
    const target = scope
    setWorking(true)
    try {
      if (prompt.mode === "mkdir") await oss.mkdir(accountId, bucket, prefix + value)
      else if (prompt.target) await oss.rename(accountId, bucket, prompt.target.key, prefix + value + (prompt.target.type === "dir" ? "/" : ""))
      if (scopeRef.current === target) { setPrompt(null); void loadPage() }
    } catch (e) { reportError(e) }
    finally { setWorking(false) }
  }

  const toggle = (key: string) => setSelected((previous) => {
    const next = new Set(previous)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  const segments = prefix.split("/").filter(Boolean)

  const pickAccount = (id: string) => {
    if (id === accountId) return
    clearListing()
    bucketRequests.invalidate()
    setAccountId(id)
    setBucket("")
    setBuckets([])
    setPrefix("")
    localStorage.setItem(LAST_ACCOUNT_KEY, id)
  }
  const pickBucket = (name: string) => {
    if (name === bucket && prefix === "") {
      void loadPage()
      return
    }
    clearListing()
    setBucket(name)
    setPrefix("")
    localStorage.setItem(LAST_BUCKET_KEY, name)
  }
  const startSignIn = async () => {
    if (signingIn) return
    setSignInError("")
    try { await login() }
    catch (e) { setSignInError(String(e)) }
  }

  if (authed === null || authed === false) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        {authed === null ? (
          <div className="flex max-w-lg flex-col items-center gap-3 text-sm">
            <p className={authError ? "text-destructive" : "text-muted-foreground"}>{authError || "Loading…"}</p>
            {authError && <Button variant="outline" size="sm" onClick={() => void retry()}>Retry connection</Button>}
          </div>
        ) : (
          <>
            <p className="text-sm">Sign in to use the OSS manager</p>
            {signingIn ? (
              <p className="text-muted-foreground flex items-center gap-2 text-sm">
                <IconRefresh className="size-4 animate-spin" />
                Complete the authorization in your browser…
                {authCode && <span className="font-mono font-semibold">Code: {authCode.userCode}</span>}
              </p>
            ) : (
              <Button size="sm" onClick={() => void startSignIn()}>
                Sign in with browser
              </Button>
            )}
            {(signInError || authError) && <p className="text-destructive text-sm">{signInError || authError}</p>}
          </>
        )}
      </div>
    )
  }

  if (accounts === null) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm">
        <IconRefresh className="text-muted-foreground size-4 animate-spin" />
        <span className="text-muted-foreground">Loading…</span>
      </div>
    )
  }

  if (accounts.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-muted-foreground text-sm">No OSS accounts configured</p>
        <Button variant="outline" size="sm" onClick={() => void cloud?.openAdmin("oss-accounts").catch(reportError)}>
          <IconExternalLink />
          Open Admin Console
        </Button>
      </div>
    )
  }

  return (
    <div
      className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:px-6"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        const paths = Array.from(e.dataTransfer.files)
          .map((f) => window.electron?.getPathForFile?.(f))
          .filter((p): p is string => Boolean(p))
        if (paths.length > 0) void upload(paths)
      }}
    >
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={accountId} onValueChange={pickAccount}>
            <SelectTrigger size="sm" className="w-40">
              <SelectValue placeholder="Account" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={bucket} onValueChange={pickBucket}>
            <SelectTrigger size="sm" className="w-52">
              <SelectValue placeholder="Bucket" />
            </SelectTrigger>
            <SelectContent>
              {buckets.map((b) => (
                <SelectItem key={b.name} value={b.name}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-2">
            <Input
              placeholder="Filter"
              className="w-36 md:w-48"
              value={searchInput}
              onChange={(e) => { setSearchInput(e.target.value); setSelected(new Set()) }}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPrompt({ mode: "mkdir", value: "" })}
              disabled={!bucket || busy}
            >
              <IconFolderPlus />
              New Folder
            </Button>
            <Button size="sm" onClick={() => void upload()} disabled={!bucket || busy}>
              <IconUpload />
              Upload
            </Button>
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-1 text-sm">
          {segments.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-label="Back"
              onClick={() => {
                const cut = segments.slice(0, -1)
                navigate(cut.length > 0 ? cut.join("/") + "/" : "")
              }}
            >
              <IconArrowLeft className="size-4" />
            </Button>
          )}
          <nav className="flex min-w-0 flex-wrap items-center gap-1">
            <button
              className="hover:bg-accent rounded px-1.5 py-0.5"
              onClick={() => navigate("")}
            >
              root
            </button>
            {segments.map((segment, i) => (
              <React.Fragment key={i}>
                <IconChevronRight className="text-muted-foreground size-3.5 shrink-0" />
                <button
                  className="hover:bg-accent rounded px-1.5 py-0.5"
                  onClick={() => navigate(segments.slice(0, i + 1).join("/") + "/")}
                >
                  {segment}
                </button>
              </React.Fragment>
            ))}
          </nav>
        </div>
      </div>

      {selected.size > 0 && (
        <div className="bg-muted/50 flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
          {selected.size} selected
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void download(selectedEntries)}>
            <IconDownload />
            Download
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={busy} onClick={() => void remove(selectedEntries)}
          >
            Delete
          </Button>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      <div className="relative flex-1 overflow-hidden rounded-lg border">
        {!bucket ? (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            Select a bucket
          </div>
        ) : loading ? (
          <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
            <IconRefresh className="size-4 animate-spin" />
            Loading…
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <p className="text-destructive text-sm">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void loadPage()}>
              Retry
            </Button>
          </div>
        ) : visible.length === 0 ? (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            {filter ? "No matches" : "Empty folder"}
          </div>
        ) : (
          <div className="h-full overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 pl-3">
                    <Checkbox
                      checked={allSelected}
                      disabled={busy}
                      onCheckedChange={(v) =>
                        setSelected(v === true ? selectVisibleKeys(visible) : new Set())
                      }
                      aria-label="Select all"
                    />
                  </TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="w-24">Size</TableHead>
                  <TableHead className="w-40">Modified</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((entry) => (
                  <TableRow key={entry.key} data-selected={selected.has(entry.key)}>
                    <TableCell className="pl-3">
                      <Checkbox
                        checked={selected.has(entry.key)}
                        disabled={busy}
                        onCheckedChange={() => toggle(entry.key)}
                        aria-label={entry.name}
                      />
                    </TableCell>
                    <TableCell className="max-w-0">
                      <button
                        className="flex w-full items-center gap-2 text-left"
                        onClick={() => onEntryClick(entry)}
                      >
                        {entryIcon(entry)}
                        <span className="truncate">{entry.name}</span>
                      </button>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {entry.type === "dir" ? "—" : formatBytes(entry.size)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatTime(entry.mtime)}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-7">
                            <IconDots className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {entry.type === "file" && (
                            <DropdownMenuItem onClick={() => void download([entry])}>
                              <IconDownload />
                              Download
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem disabled={busy}
                            onClick={() => setPrompt({ mode: "rename", value: entry.name, target: entry })}
                          >
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem disabled={busy} variant="destructive" onClick={() => void remove([entry])}>
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {dragOver && (
          <div className="bg-primary/5 pointer-events-none absolute inset-2 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/40">
            <span className="text-primary text-sm">Drop files to upload here</span>
          </div>
        )}
      </div>

      {truncated && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
          <p className="text-muted-foreground">More objects are available. Filter searches only the {entries.length} loaded entries.</p>
          <Button variant="outline" size="sm" disabled={busy || !nextMarker} onClick={() => void loadPage(nextMarker)}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}

      <Dialog open={prompt !== null} onOpenChange={(o) => !o && !working && setPrompt(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{prompt?.mode === "mkdir" ? "New Folder" : "Rename"}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            disabled={working}
            value={prompt?.value ?? ""}
            onChange={(e) => prompt && setPrompt({ ...prompt, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitPrompt()
            }}
          />
          <DialogFooter>
            <Button variant="outline" disabled={working} onClick={() => setPrompt(null)}>
              Cancel
            </Button>
            <Button onClick={() => void submitPrompt()} disabled={busy || !prompt?.value.trim()}>
              {prompt?.mode === "mkdir" ? "Create" : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="truncate pr-8">{preview?.name}</DialogTitle>
          </DialogHeader>
          {preview && <MediaPreview
            key={preview.key}
            name={preview.name}
            url={preview.url}
            refreshUrl={async () => {
              if (!oss || scopeRef.current !== preview.scope) throw new Error("Preview is no longer available")
              return (await oss.previewUrl(accountId, bucket, preview.key)).url
            }}
            onUrlChange={(url) => setPreview((current) => current?.key === preview.key && current.scope === preview.scope ? { ...current, url } : current)}
            onRefreshError={handleError}
          />}
          {preview && (
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => window.open(preview.url, "_blank")}
              >
                <IconExternalLink />
                Open in Browser
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
