import * as React from "react"
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
  IconPlayerPlay,
  IconRefresh,
  IconSettings,
  IconUpload,
  IconVideo,
} from "@tabler/icons-react"
import { toast } from "sonner"

import { TransferPanel } from "@/components/cloud/transfer-panel"
import { useCloudSettings } from "@/components/cloud/settings"
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
  const { configured, open: openSettings } = useCloudSettings()
  const cloud = window.electron?.cloud

  const [currentPath, setCurrentPath] = React.useState("/")
  const [entries, setEntries] = React.useState<CloudEntry[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState("")
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [searchQ, setSearchQ] = React.useState("")
  const [dragOver, setDragOver] = React.useState(false)
  const [prompt, setPrompt] = React.useState<PromptState | null>(null)
  const [preview, setPreview] = React.useState<{ entry: CloudEntry; url: string } | null>(null)

  const load = React.useCallback(
    async (dir: string) => {
      if (!cloud) return
      setLoading(true)
      setError("")
      try {
        const res = await cloud.list(dir)
        setEntries(res.entries)
      } catch (e) {
        setError(String(e))
      } finally {
        setLoading(false)
      }
    },
    [cloud]
  )

  React.useEffect(() => {
    if (configured && !searchQ) void load(currentPath)
  }, [configured, currentPath, searchQ, load])

  React.useEffect(() => {
    if (!configured || !searchQ.trim()) return
    const timer = setTimeout(async () => {
      try {
        const res = await cloud!.search(searchQ.trim())
        setEntries(res.entries)
      } catch (e) {
        toast.error(String(e))
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQ, configured, cloud])

  const navigate = (dir: string) => {
    setCurrentPath(dir)
    setSelected(new Set())
    setSearchQ("")
  }

  const selectedEntries = entries.filter((e) => selected.has(e.path))

  const upload = async (localPaths?: string[]) => {
    if (!cloud) return
    try {
      if (localPaths && localPaths.length > 0) {
        await cloud.uploadFiles(localPaths, currentPath)
      } else {
        await cloud.pickAndUpload(currentPath)
      }
      toast.success("上传完成")
      void load(currentPath)
    } catch (e) {
      toast.error(String(e))
    }
  }

  const download = async (list: CloudEntry[]) => {
    const files = list.filter((e) => e.type === "file")
    if (files.length === 0 || !cloud) return
    const dir = await cloud.chooseDownloadDir()
    if (!dir) return
    try {
      for (const f of files) {
        await cloud.downloadTo(f.path, f.name, dir)
      }
      toast.success(`已下载到 ${dir}`)
    } catch (e) {
      toast.error(String(e))
    }
  }

  const remove = async (list: CloudEntry[]) => {
    if (!cloud || list.length === 0) return
    if (!window.confirm(`确定删除 ${list.length} 项？`)) return
    try {
      await cloud.remove(list.map((e) => e.path))
      setSelected(new Set())
      void load(currentPath)
    } catch (e) {
      toast.error(String(e))
    }
  }

  const onEntryClick = (entry: CloudEntry) => {
    if (entry.type === "dir") {
      navigate(entry.path)
      return
    }
    const kind = fileKind(entry.name)
    if (kind === "image" || kind === "video" || kind === "audio") {
      void cloud?.fileUrl(entry.path).then((url) => setPreview({ entry, url }))
    } else {
      void download([entry])
    }
  }

  const submitPrompt = async () => {
    if (!prompt || !cloud) return
    const value = prompt.value.trim()
    if (!value) return
    try {
      if (prompt.mode === "mkdir") {
        await cloud.mkdir(currentPath === "/" ? `/${value}` : `${currentPath}/${value}`)
      } else if (prompt.target) {
        const parent = prompt.target.path.slice(0, prompt.target.path.lastIndexOf("/")) || "/"
        await cloud.rename(prompt.target.path, parent === "/" ? `/${value}` : `${parent}/${value}`)
      }
      setPrompt(null)
      void load(currentPath)
    } catch (e) {
      toast.error(String(e))
    }
  }

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const segments = currentPath.split("/").filter(Boolean)
  const allSelected = entries.length > 0 && entries.every((e) => selected.has(e.path))

  if (!configured) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-muted-foreground text-sm">云盘未配置</p>
        <Button variant="outline" size="sm" onClick={openSettings}>
          <IconSettings />
          打开设置
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
      <div className="flex flex-wrap items-center gap-2">
        {segments.length > 0 && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7"
            onClick={() => navigate(segments.slice(0, -1).join("/") ? `/${segments.slice(0, -1).join("/")}` : "/")}
          >
            <IconArrowLeft className="size-4" />
          </Button>
        )}
        <nav className="flex min-w-0 items-center gap-1 text-sm">
          <button className="hover:bg-accent rounded px-1.5 py-0.5" onClick={() => navigate("/")}>
            云盘
          </button>
          {segments.map((seg, i) => (
            <React.Fragment key={i}>
              <IconChevronRight className="text-muted-foreground size-3.5 shrink-0" />
              <button
                className="hover:bg-accent rounded px-1.5 py-0.5"
                onClick={() => navigate(`/${segments.slice(0, i + 1).join("/")}`)}
              >
                {seg}
              </button>
            </React.Fragment>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Input
            placeholder="搜索文件"
            className="w-44 md:w-56"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPrompt({ mode: "mkdir", value: "" })}
          >
            <IconFolderPlus />
            新建文件夹
          </Button>
          <Button size="sm" onClick={() => void upload()}>
            <IconUpload />
            上传
          </Button>
        </div>
      </div>

      {selected.size > 0 && (
        <div className="bg-muted/50 flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
          已选 {selected.size} 项
          <Button variant="outline" size="sm" onClick={() => void download(selectedEntries)}>
            <IconDownload />
            下载
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => void remove(selectedEntries)}
          >
            删除
          </Button>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setSelected(new Set())}>
            取消选择
          </Button>
        </div>
      )}

      <div className="relative flex-1 overflow-hidden rounded-lg border">
        {loading ? (
          <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
            <IconRefresh className="size-4 animate-spin" />
            加载中…
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <p className="text-destructive text-sm">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void load(currentPath)}>
              重试
            </Button>
          </div>
        ) : entries.length === 0 ? (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            {searchQ ? "无匹配结果" : "空目录"}
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
                        setSelected(v === true ? new Set(entries.map((e) => e.path)) : new Set())
                      }
                      aria-label="全选"
                    />
                  </TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead className="w-24">大小</TableHead>
                  <TableHead className="w-40">修改时间</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow key={entry.path} data-selected={selected.has(entry.path)}>
                    <TableCell className="pl-3">
                      <Checkbox
                        checked={selected.has(entry.path)}
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
                              下载
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            onClick={() => setPrompt({ mode: "rename", value: entry.name, target: entry })}
                          >
                            重命名
                          </DropdownMenuItem>
                          <DropdownMenuItem variant="destructive" onClick={() => void remove([entry])}>
                            删除
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
            <span className="text-primary text-sm">松开以上传到当前目录</span>
          </div>
        )}
      </div>

      <TransferPanel />

      <Dialog open={prompt !== null} onOpenChange={(o) => !o && setPrompt(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{prompt?.mode === "mkdir" ? "新建文件夹" : "重命名"}</DialogTitle>
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
              取消
            </Button>
            <Button onClick={() => void submitPrompt()} disabled={!prompt?.value.trim()}>
              确定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="truncate pr-8">{preview?.entry.name}</DialogTitle>
          </DialogHeader>
          {preview &&
            (fileKind(preview.entry.name) === "image" ? (
              <img src={preview.url} alt={preview.entry.name} className="max-h-[70vh] w-full object-contain" />
            ) : fileKind(preview.entry.name) === "video" ? (
              <video src={preview.url} controls className="max-h-[70vh] w-full" />
            ) : (
              <div className="flex items-center justify-center gap-2 py-10">
                <IconPlayerPlay className="text-muted-foreground size-5" />
                <audio src={preview.url} controls />
              </div>
            ))}
          {preview && (
            <DialogFooter>
              <Button variant="outline" onClick={() => void download([preview.entry])}>
                <IconDownload />
                下载
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
