import * as React from "react"
import { Link } from "react-router-dom"
import {
  IconArrowLeft,
  IconChevronRight,
  IconDots,
  IconDownload,
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
import { useDebounce } from "use-debounce"

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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { fileKind, formatBytes, formatTime } from "@/lib/format"
import { createRequestTracker, fileOperationError, isTransferCancelled } from "@/lib/file-operations"
import type { CloudEntry } from "@/types/global"

function entryIcon(entry: CloudEntry) {
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
  target?: CloudEntry
}

export default function CloudDrivePage() {
  const { authed, login, error: authError, retry, authCode, signingIn, handleError } = useCloudAuth()
  const cloud = window.electron?.cloud
  const [signInError, setSignInError] = React.useState("")
  const [currentPath, setCurrentPath] = React.useState("/")
  const [entries, setEntries] = React.useState<CloudEntry[]>([])
  const [loading, setLoading] = React.useState(false)
  const [working, setWorking] = React.useState(false)
  const [error, setError] = React.useState("")
  const [deleteNotice, setDeleteNotice] = React.useState("")
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [searchInput, setSearchInput] = React.useState("")
  const [searchQ] = useDebounce(searchInput, 300)
  const [dragOver, setDragOver] = React.useState(false)
  const [prompt, setPrompt] = React.useState<PromptState | null>(null)
  const [preview, setPreview] = React.useState<{ entry: CloudEntry; url: string; scope: string } | null>(null)
  const requests = React.useRef(createRequestTracker()).current
  const scope = `${currentPath}\0${searchInput}`
  const scopeRef = React.useRef(scope)
  scopeRef.current = scope
  const busy = loading || working

  const reportError = React.useCallback((e: unknown) => {
    if (isTransferCancelled(e)) { toast.info("Transfer cancelled"); return }
    handleError(e)
    toast.error(fileOperationError(e))
  }, [handleError])

  const load = React.useCallback(async (dir: string, query = "") => {
    if (!cloud) return
    const request = requests.start()
    setLoading(true)
    setError("")
    setEntries([])
    setSelected(new Set())
    try {
      const res = query.trim() ? await cloud.search(query.trim()) : await cloud.list(dir)
      if (requests.isCurrent(request)) setEntries(res.entries)
    } catch (e) {
      if (!requests.isCurrent(request)) return
      setError(fileOperationError(e))
      handleError(e)
    } finally {
      if (requests.isCurrent(request)) setLoading(false)
    }
  }, [cloud, requests, handleError])

  React.useEffect(() => {
    if (authed && searchQ === searchInput) void load(currentPath, searchQ)
    return () => requests.invalidate()
  }, [authed, currentPath, searchQ, searchInput, load, requests])

  const clearListing = () => {
    requests.invalidate()
    setEntries([])
    setSelected(new Set())
    setLoading(true)
    setError("")
    setPrompt(null)
    setPreview(null)
  }
  const navigate = (dir: string) => {
    if (dir === currentPath && !searchInput) {
      void load(dir)
      return
    }
    clearListing()
    setCurrentPath(dir)
    setSearchInput("")
  }
  const selectedEntries = entries.filter((entry) => selected.has(entry.path))

  const upload = async (localPaths?: string[]) => {
    if (!cloud || busy) return
    const target = scope
    setWorking(true)
    try {
      const uploaded = localPaths?.length
        ? await cloud.uploadFiles(localPaths, currentPath)
        : await cloud.pickAndUpload(currentPath)
      if (!uploaded?.length) return
      toast.success("Upload complete")
      if (scopeRef.current === target) void load(currentPath, searchQ)
    } catch (e) { reportError(e) }
    finally { setWorking(false) }
  }

  const download = async (list: CloudEntry[]) => {
    const files = list.filter((entry) => entry.type === "file")
    if (!files.length || !cloud || busy) return
    try {
      const dir = await cloud.chooseDownloadDir()
      if (!dir) return
      for (const file of files) await cloud.downloadTo(file.path, file.name, dir)
      toast.success(`Saved to ${dir}`)
    } catch (e) { reportError(e) }
  }

  const remove = async (list: CloudEntry[]) => {
    if (!cloud || !list.length || busy) return
    const includesFolders = list.some((entry) => entry.type === "dir")
    if (!window.confirm(`Move ${list.length} item${list.length > 1 ? "s" : ""} to Trash?${includesFolders ? " Folder contents will move with them." : ""} You can restore them from Trash.`)) return
    const target = scope
    setWorking(true)
    setDeleteNotice("")
    try {
      await cloud.remove(list.map((entry) => entry.path))
      toast.success("Moved selected items to Trash")
      if (scopeRef.current === target) await load(currentPath, searchQ)
    } catch (e) {
      reportError(e)
      if (scopeRef.current === target) {
        setDeleteNotice(`Some items may already have moved to Trash. Review the current list and Trash before trying again. ${fileOperationError(e)}`)
        await load(currentPath, searchQ)
      }
    } finally { setWorking(false) }
  }

  const onEntryClick = (entry: CloudEntry) => {
    if (busy) return
    if (entry.type === "dir") { navigate(entry.path); return }
    const kind = fileKind(entry.name)
    if (kind === "image" || kind === "video" || kind === "audio") {
      const target = scope
      void cloud?.fileUrl(entry.path).then((url) => {
        if (scopeRef.current === target) setPreview({ entry, url, scope: target })
      }).catch(reportError)
    } else void download([entry])
  }

  const submitPrompt = async () => {
    if (!prompt || !cloud || busy) return
    const value = prompt.value.trim()
    if (!value) return
    if (/[/\\]/.test(value) || value === "." || value === "..") {
      toast.error("Enter a name without path separators.")
      return
    }
    const target = scope
    setWorking(true)
    try {
      if (prompt.mode === "mkdir") await cloud.mkdir(currentPath === "/" ? `/${value}` : `${currentPath}/${value}`)
      else if (prompt.target) {
        const parent = prompt.target.path.slice(0, prompt.target.path.lastIndexOf("/")) || "/"
        await cloud.rename(prompt.target.path, parent === "/" ? `/${value}` : `${parent}/${value}`)
      }
      if (scopeRef.current === target) { setPrompt(null); void load(currentPath, searchQ) }
    } catch (e) { reportError(e) }
    finally { setWorking(false) }
  }

  const toggle = (path: string) => setSelected((previous) => {
    const next = new Set(previous)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })
  const segments = currentPath.split("/").filter(Boolean)
  const allSelected = entries.length > 0 && entries.every((entry) => selected.has(entry.path))
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
            <p className="text-sm">Sign in to use the cloud drive</p>
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
      <div className="flex flex-wrap items-center gap-2">
        {segments.length > 0 && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Back"
            onClick={() =>
              navigate(
                segments.slice(0, -1).length > 0 ? `/${segments.slice(0, -1).join("/")}` : "/"
              )
            }
          >
            <IconArrowLeft className="size-4" />
          </Button>
        )}
        <nav className="flex min-w-0 items-center gap-1 text-sm">
          <button className="hover:bg-accent rounded px-1.5 py-0.5" onClick={() => navigate("/")}>
            Cloud
          </button>
          {segments.map((segment, i) => (
            <React.Fragment key={i}>
              <IconChevronRight className="text-muted-foreground size-3.5 shrink-0" />
              <button
                className="hover:bg-accent rounded px-1.5 py-0.5"
                onClick={() => navigate(`/${segments.slice(0, i + 1).join("/")}`)}
              >
                {segment}
              </button>
            </React.Fragment>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Input
            placeholder="Search files"
            className="w-44 md:w-56"
            value={searchInput}
            onChange={(e) => {
              clearListing()
              setSearchInput(e.target.value)
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={busy} onClick={() => setPrompt({ mode: "mkdir", value: "" })}
          >
            <IconFolderPlus />
            New Folder
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void upload()}>
            <IconUpload />
            Upload
          </Button>
        </div>
      </div>

      {deleteNotice && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm"><p className="text-destructive flex-1 break-words">{deleteNotice}</p><Button asChild variant="outline" size="sm"><Link to="/trash">View Trash</Link></Button></div>}

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
        {loading ? (
          <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
            <IconRefresh className="size-4 animate-spin" />
            Loading…
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <p className="text-destructive text-sm">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void load(currentPath, searchQ)}>
              Retry
            </Button>
          </div>
        ) : entries.length === 0 ? (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            {searchQ ? "No results" : "Empty folder"}
          </div>
        ) : (
          <div className="h-full overflow-auto [scrollbar-gutter:stable]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 pl-3">
                    <Checkbox
                      checked={allSelected}
                      disabled={busy}
                      onCheckedChange={(v) =>
                        setSelected(v === true ? new Set(entries.map((e) => e.path)) : new Set())
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
                {entries.map((entry) => (
                  <TableRow key={entry.path} data-selected={selected.has(entry.path)}>
                    <TableCell className="pl-3">
                      <Checkbox
                        checked={selected.has(entry.path)}
                        disabled={busy}
                        onCheckedChange={() => toggle(entry.path)}
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
                        {searchQ && entry.type === "file" && (
                          <span className="text-muted-foreground truncate text-xs">
                            {entry.path}
                          </span>
                        )}
                      </button>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {entry.type === "dir" ? "—" : formatBytes(entry.size)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatTime(entry.mtime)}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu modal={false}>
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
                            onClick={() =>
                              setPrompt({ mode: "rename", value: entry.name, target: entry })
                            }
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
            <DialogTitle className="truncate pr-8">{preview?.entry.name}</DialogTitle>
          </DialogHeader>
          {preview && <MediaPreview
            key={preview.entry.path}
            name={preview.entry.name}
            url={preview.url}
            refreshUrl={async () => {
              if (!cloud || scopeRef.current !== preview.scope) throw new Error("Preview is no longer available")
              return cloud.fileUrl(preview.entry.path)
            }}
            onUrlChange={(url) => setPreview((current) => current?.entry.path === preview.entry.path && current.scope === preview.scope ? { ...current, url } : current)}
            onRefreshError={handleError}
          />}
          {preview && (
            <DialogFooter>
              <Button variant="outline" onClick={() => void download([preview.entry])}>
                <IconDownload />
                Download
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
