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
  IconPlayerPlay,
  IconRefresh,
  IconUpload,
  IconVideo,
} from "@tabler/icons-react"
import { toast } from "sonner"

import { TransferPanel } from "@/components/cloud/transfer-panel"
import { useCloudAuth } from "@/components/cloud/auth"
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
import type { OssAccountInfo, OssBucketInfo, OssEntry } from "@/types/global"

const ADMIN_URL = "https://halloween.yxswy.com/admin/#/oss-accounts"
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
  const { authed, login } = useCloudAuth()
  const oss = window.electron?.oss
  const cloud = window.electron?.cloud
  const [signingIn, setSigningIn] = React.useState(false)
  const [signInError, setSignInError] = React.useState("")

  const [accounts, setAccounts] = React.useState<OssAccountInfo[] | null>(null)
  const [accountId, setAccountId] = React.useState("")
  const [buckets, setBuckets] = React.useState<OssBucketInfo[]>([])
  const [bucket, setBucket] = React.useState("")
  const [prefix, setPrefix] = React.useState("")
  const [entries, setEntries] = React.useState<OssEntry[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState("")
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [searchInput, setSearchInput] = React.useState("")
  const [dragOver, setDragOver] = React.useState(false)
  const [prompt, setPrompt] = React.useState<PromptState | null>(null)
  const [preview, setPreview] = React.useState<{ name: string; url: string } | null>(null)

  React.useEffect(() => {
    if (!authed) return
    oss
      ?.accounts()
      .then((res) => {
        setAccounts(res.accounts)
        const saved = localStorage.getItem(LAST_ACCOUNT_KEY)
        if (saved && res.accounts.some((a) => a.id === saved)) setAccountId(saved)
      })
      .catch((e) => {
        setAccounts([])
        toast.error(String(e))
      })
  }, [oss, authed])

  React.useEffect(() => {
    if (!accountId) {
      setBuckets([])
      setBucket("")
      return
    }
    oss
      ?.buckets(accountId)
      .then((res) => {
        setBuckets(res.buckets)
        const saved = localStorage.getItem(LAST_BUCKET_KEY)
        setBucket(
          saved && res.buckets.some((b) => b.name === saved)
            ? saved
            : (res.buckets[0]?.name ?? "")
        )
      })
      .catch((e) => toast.error(String(e)))
  }, [accountId, oss])

  const load = React.useCallback(async () => {
    if (!oss || !accountId || !bucket) return
    setLoading(true)
    setError("")
    try {
      const res = await oss.objects(accountId, bucket, prefix)
      setEntries(res.entries)
      setSelected(new Set())
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [oss, accountId, bucket, prefix])

  React.useEffect(() => {
    void load()
  }, [load])

  const selectedEntries = entries.filter((e) => selected.has(e.key))

  const upload = async (localPaths?: string[]) => {
    if (!oss || !accountId || !bucket) return
    try {
      const uploaded =
        localPaths && localPaths.length > 0
          ? await oss.uploadFiles(accountId, bucket, prefix, localPaths)
          : await oss.pickAndUpload(accountId, bucket, prefix)
      if (!uploaded || uploaded.length === 0) return
      toast.success("Upload complete")
      void load()
    } catch (e) {
      toast.error(String(e))
    }
  }

  const download = async (list: OssEntry[]) => {
    const files = list.filter((e) => e.type === "file")
    if (files.length === 0 || !oss || !cloud) return
    const dir = await cloud.chooseDownloadDir()
    if (!dir) return
    try {
      for (const f of files) {
        await oss.downloadTo(accountId, bucket, f.key, f.name, dir)
      }
      toast.success(`Saved to ${dir}`)
    } catch (e) {
      toast.error(String(e))
    }
  }

  const remove = async (list: OssEntry[]) => {
    if (!oss || list.length === 0) return
    if (!window.confirm(`Delete ${list.length} item${list.length > 1 ? "s" : ""}?`)) return
    try {
      await oss.remove(
        accountId,
        bucket,
        list.map((e) => e.key)
      )
      void load()
    } catch (e) {
      toast.error(String(e))
    }
  }

  const onEntryClick = (entry: OssEntry) => {
    if (entry.type === "dir") {
      setPrefix(entry.key)
      setSearchInput("")
      return
    }
    const kind = fileKind(entry.name)
    if (kind === "image" || kind === "video" || kind === "audio") {
      void oss
        ?.previewUrl(accountId, bucket, entry.key)
        .then(({ url }) => setPreview({ name: entry.name, url }))
    } else {
      void download([entry])
    }
  }

  const submitPrompt = async () => {
    if (!prompt || !oss) return
    const value = prompt.value.trim()
    if (!value) return
    try {
      if (prompt.mode === "mkdir") {
        await oss.mkdir(accountId, bucket, prefix + value)
      } else if (prompt.target) {
        await oss.rename(accountId, bucket, prompt.target.key, prefix + value)
      }
      setPrompt(null)
      void load()
    } catch (e) {
      toast.error(String(e))
    }
  }

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const segments = prefix.split("/").filter(Boolean)
  const allSelected = entries.length > 0 && entries.every((e) => selected.has(e.key))
  const filter = searchInput.trim().toLowerCase()
  const visible = filter
    ? entries.filter((e) => e.name.toLowerCase().includes(filter))
    : entries

  const pickAccount = (id: string) => {
    setAccountId(id)
    localStorage.setItem(LAST_ACCOUNT_KEY, id)
  }

  const pickBucket = (name: string) => {
    setBucket(name)
    setPrefix("")
    localStorage.setItem(LAST_BUCKET_KEY, name)
  }

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
            <p className="text-sm">Sign in to use the OSS manager</p>
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
        <Button variant="outline" size="sm" onClick={() => window.open(ADMIN_URL, "_blank")}>
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
              onChange={(e) => setSearchInput(e.target.value)}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPrompt({ mode: "mkdir", value: "" })}
              disabled={!bucket}
            >
              <IconFolderPlus />
              New Folder
            </Button>
            <Button size="sm" onClick={() => void upload()} disabled={!bucket}>
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
                setPrefix(cut.length > 0 ? cut.join("/") + "/" : "")
              }}
            >
              <IconArrowLeft className="size-4" />
            </Button>
          )}
          <nav className="flex min-w-0 flex-wrap items-center gap-1">
            <button
              className="hover:bg-accent rounded px-1.5 py-0.5"
              onClick={() => setPrefix("")}
            >
              root
            </button>
            {segments.map((segment, i) => (
              <React.Fragment key={i}>
                <IconChevronRight className="text-muted-foreground size-3.5 shrink-0" />
                <button
                  className="hover:bg-accent rounded px-1.5 py-0.5"
                  onClick={() => setPrefix(segments.slice(0, i + 1).join("/") + "/")}
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
          <Button variant="outline" size="sm" onClick={() => void download(selectedEntries)}>
            <IconDownload />
            Download
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => void remove(selectedEntries)}
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
            <Button variant="outline" size="sm" onClick={() => void load()}>
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
                      onCheckedChange={(v) =>
                        setSelected(v === true ? new Set(entries.map((e) => e.key)) : new Set())
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
                          <DropdownMenuItem
                            onClick={() => setPrompt({ mode: "rename", value: entry.name, target: entry })}
                          >
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem variant="destructive" onClick={() => void remove([entry])}>
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

      <TransferPanel />

      <Dialog open={prompt !== null} onOpenChange={(o) => !o && setPrompt(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{prompt?.mode === "mkdir" ? "New Folder" : "Rename"}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={prompt?.value ?? ""}
            onChange={(e) => prompt && setPrompt({ ...prompt, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitPrompt()
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setPrompt(null)}>
              Cancel
            </Button>
            <Button onClick={() => void submitPrompt()} disabled={!prompt?.value.trim()}>
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
          {preview &&
            (fileKind(preview.name) === "image" ? (
              <img
                src={preview.url}
                alt={preview.name}
                className="max-h-[70vh] w-full object-contain"
              />
            ) : fileKind(preview.name) === "video" ? (
              <video src={preview.url} controls className="max-h-[70vh] w-full" />
            ) : (
              <div className="flex items-center justify-center gap-2 py-10">
                <IconPlayerPlay className="text-muted-foreground size-5" />
                <audio src={preview.url} controls />
              </div>
            ))}
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
