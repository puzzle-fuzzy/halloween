import * as React from "react"
import { Link } from "react-router-dom"
import { IconArrowBackUp, IconFile, IconFolder, IconRefresh, IconTrash } from "@tabler/icons-react"
import { toast } from "sonner"

import { useCloudAuth } from "@/components/cloud/auth"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { createRequestTracker } from "@/lib/file-operations"
import { formatBytes, formatTime } from "@/lib/format"
import { alternativeRestorePath, isRestoreConflict, selectedRecoverable, trashName, validRestorePath } from "@/lib/storage-maintenance"
import type { TrashEntry, TrashListing, TrashPurgeInput } from "@/types/global"

interface RestoreConflict { entry: TrashEntry; destination: string; error?: string }
interface PurgeIntent { ids?: string[]; all?: boolean; phrase: TrashPurgeInput["confirmation"] }

export default function TrashPage() {
  const auth = useCloudAuth()
  const cloud = window.electron?.cloud
  const [listing, setListing] = React.useState<TrashListing | null>(null)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [loading, setLoading] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [failures, setFailures] = React.useState<string[]>([])
  const [warnings, setWarnings] = React.useState<string[]>([])
  const [conflicts, setConflicts] = React.useState<RestoreConflict[]>([])
  const [purge, setPurge] = React.useState<PurgeIntent | null>(null)
  const [confirmation, setConfirmation] = React.useState("")
  const [purgeNotice, setPurgeNotice] = React.useState("")
  const [purgeFailures, setPurgeFailures] = React.useState<string[]>([])
  const mounted = React.useRef(false)
  const lifecycle = React.useRef(0)
  const requests = React.useRef(createRequestTracker()).current
  const handleError = auth.handleError
  const blocked = loading || busy

  const load = React.useCallback(async () => {
    if (!cloud) return
    const request = requests.start()
    setLoading(true)
    setError("")
    setSelected(new Set())
    try {
      const result = await cloud.listTrash()
      if (mounted.current && requests.isCurrent(request)) setListing(result)
    } catch (e) {
      if (!mounted.current || !requests.isCurrent(request)) return
      setError(String(e))
      handleError(e)
    } finally {
      if (mounted.current && requests.isCurrent(request)) setLoading(false)
    }
  }, [cloud, handleError, requests])

  React.useEffect(() => {
    mounted.current = true
    lifecycle.current += 1
    setBusy(false)
    if (auth.authed) void load()
    else {
      setListing(null); setSelected(new Set()); setConflicts([]); setPurge(null)
      setFailures([]); setWarnings([]); setPurgeNotice(""); setPurgeFailures([])
    }
    return () => { mounted.current = false; lifecycle.current += 1; requests.invalidate() }
  }, [auth.authed, load, requests])

  const restore = async (items: TrashEntry[]) => {
    if (!cloud || blocked || !items.length) return
    const operation = lifecycle.current
    const current = () => mounted.current && lifecycle.current === operation
    setBusy(true)
    setFailures([])
    setWarnings([])
    const pending: RestoreConflict[] = []
    const failed: string[] = []
    const notices: string[] = []
    let restored = 0
    try {
      for (const entry of items) {
        if (!current()) break
        try {
          const result = await cloud.restoreTrash(entry.id)
          restored += 1
          if (result.warning) notices.push(`${trashName(entry)}: ${result.warning}`)
        }
        catch (e) {
          if (!current()) break
          handleError(e)
          if (isRestoreConflict(e)) pending.push({ entry, destination: alternativeRestorePath(entry) })
          else failed.push(`${trashName(entry)}: ${String(e)}`)
        }
      }
      if (!current()) return
      if (restored) toast.success(`Restored ${restored} item${restored === 1 ? "" : "s"}`)
      setConflicts(pending)
      setFailures(failed)
      setWarnings(notices)
      await load()
    } finally {
      if (current()) setBusy(false)
    }
  }

  const restoreConflict = async () => {
    const conflict = conflicts[0]
    if (!cloud || !conflict || blocked) return
    const destination = conflict.destination.trim()
    if (!validRestorePath(destination)) {
      setConflicts((current) => current.map((item, index) => index === 0 ? { ...item, error: "Enter a full cloud path, without hidden names or dot segments, such as /photos/holiday-restored.jpg." } : item))
      return
    }
    const operation = lifecycle.current
    const current = () => mounted.current && lifecycle.current === operation
    setBusy(true)
    try {
      const result = await cloud.restoreTrash(conflict.entry.id, destination)
      if (!current()) return
      toast.success(`Restored to ${result.path}`)
      if (result.warning) setWarnings((current) => [...current, result.warning!])
      setConflicts((current) => current.slice(1))
      await load()
    } catch (e) {
      if (!current()) return
      handleError(e)
      const message = isRestoreConflict(e) ? "That path already exists. Choose a different destination." : String(e)
      setConflicts((current) => current.map((item, index) => index === 0 ? { ...item, error: message } : item))
    } finally {
      if (current()) setBusy(false)
    }
  }

  const openPurge = (intent: PurgeIntent) => {
    setConfirmation("")
    setPurge(intent)
  }
  const purgeConfirmed = async () => {
    if (!cloud || !purge || blocked || confirmation !== purge.phrase) return
    const operation = lifecycle.current
    const current = () => mounted.current && lifecycle.current === operation
    setBusy(true)
    setPurgeNotice("")
    setPurgeFailures([])
    try {
      const result = await cloud.purgeTrash({ ids: purge.ids, all: purge.all, confirmation: purge.phrase })
      if (!current()) return
      if (!result.ok || result.failed?.length) {
        setPurgeNotice(`Permanently deleted ${result.purged} item${result.purged === 1 ? "" : "s"}. Some items could not be deleted. Review the current list and confirm a new deletion for the remaining items.`)
        setPurgeFailures((result.failed ?? []).map((failure) => {
          const entry = listing?.entries.find((item) => item.id === failure.id)
          return `${entry ? trashName(entry) : failure.id}: ${failure.error}`
        }))
        toast.warning("Some items could not be permanently deleted")
      } else toast.success(`Permanently deleted ${result.purged} item${result.purged === 1 ? "" : "s"}`)
    } catch (e) {
      if (!current()) return
      handleError(e)
      setPurgeNotice("The deletion result could not be confirmed. Some items may already have been permanently deleted. Review the current list and select any remaining items for a new confirmation.")
      setPurgeFailures([String(e)])
    } finally {
      if (current()) {
        // Never replay old IDs after an uncertain or partially successful deletion.
        setPurge(null)
        setConfirmation("")
        setSelected(new Set())
        await load()
        if (current()) setBusy(false)
      }
    }
  }

  const entries = listing?.entries ?? []
  const recoverable = selectedRecoverable(entries, selected)
  const allSelected = entries.length > 0 && entries.every((entry) => selected.has(entry.id))
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  if (!auth.authed) return <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm">
    <p>{auth.error || (auth.authed === null ? "Checking your connection…" : "Sign in to manage deleted files.")}</p>
    {auth.authed === null && auth.error ? <Button variant="outline" onClick={() => void auth.retry()}>Retry connection</Button> : auth.authed === false && <Button asChild><Link to="/cloud">Sign in to cloud drive</Link></Button>}
  </div>

  return <div className="flex flex-1 flex-col gap-5 p-4 lg:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-xl font-semibold">Trash</h2><p className="text-muted-foreground mt-1 text-sm">Restore deleted cloud files or permanently remove them.</p></div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={blocked} onClick={() => void load()}><IconRefresh />Refresh</Button>
        <Button variant="destructive" size="sm" disabled={blocked || !entries.length} onClick={() => openPurge({ all: true, phrase: "EMPTY_TRASH" })}><IconTrash />Empty trash</Button>
      </div>
    </div>
    <div className="grid gap-3 sm:grid-cols-3">
      <Card><CardHeader><CardDescription>Deleted items</CardDescription><CardTitle>{listing ? entries.length : "—"}</CardTitle></CardHeader></Card>
      <Card><CardHeader><CardDescription>Recoverable items</CardDescription><CardTitle>{listing ? entries.filter((entry) => entry.recoverable).length : "—"}</CardTitle></CardHeader></Card>
      <Card><CardHeader><CardDescription>{listing?.incomplete ? "Known storage used (at least)" : "Trash storage used"}</CardDescription><CardTitle>{listing ? listing.totalBytes === 0 ? "0 B" : formatBytes(listing.totalBytes) : "—"}</CardTitle></CardHeader></Card>
    </div>
    {listing?.incomplete && <p role="status" className="rounded-lg border p-3 text-sm">Some items could not be fully read. Their storage may be missing from this total. Damaged items remain listed and can be permanently deleted.</p>}
    {error && <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm"><p className="text-destructive break-words">{error}</p><Button variant="outline" size="sm" disabled={blocked} onClick={() => void load()}>Retry</Button></div>}
    {failures.length > 0 && <Card><CardHeader><CardTitle className="text-sm">Some items could not be restored</CardTitle></CardHeader><CardContent><ul className="space-y-1 text-sm text-destructive">{failures.map((message, index) => <li key={index} className="break-words">{message}</li>)}</ul></CardContent></Card>}
    {warnings.length > 0 && <Card><CardHeader><CardTitle className="text-sm">Restored with a warning</CardTitle></CardHeader><CardContent><ul role="status" className="space-y-1 text-sm">{warnings.map((message, index) => <li key={index} className="break-words">{message}</li>)}</ul></CardContent></Card>}
    {purgeNotice && <Card><CardHeader><CardTitle className="text-sm">Permanent deletion needs review</CardTitle></CardHeader><CardContent role="alert" className="space-y-2 text-sm"><p>{purgeNotice}</p>{purgeFailures.length > 0 && <ul className="space-y-1 text-destructive">{purgeFailures.map((message, index) => <li key={index} className="break-words">{message}</li>)}</ul>}</CardContent></Card>}
    {selected.size > 0 && <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
      <span>{selected.size} selected</span>
      <Button size="sm" variant="outline" disabled={blocked || !recoverable.length} onClick={() => void restore(recoverable)}><IconArrowBackUp />Restore {recoverable.length} item{recoverable.length === 1 ? "" : "s"}</Button>
      <Button size="sm" variant="destructive" disabled={blocked} onClick={() => openPurge({ ids: [...selected], phrase: "DELETE" })}>Permanently delete</Button>
      <Button size="sm" variant="ghost" disabled={blocked} onClick={() => setSelected(new Set())}>Clear selection</Button>
      {recoverable.length < selected.size && <span className="text-muted-foreground">Damaged items are excluded from restore.</span>}
    </div>}
    <div className="min-h-40 overflow-auto rounded-lg border">
      {loading && !listing ? <p className="text-muted-foreground p-6 text-sm">Loading deleted files…</p> : entries.length === 0 ? <p className="text-muted-foreground p-6 text-sm">{error ? "Deleted files could not be loaded." : "Trash is empty."}</p> : <Table>
        <TableHeader><TableRow><TableHead className="w-10"><Checkbox aria-label="Select all deleted items" checked={allSelected} disabled={blocked} onCheckedChange={(checked) => setSelected(checked === true ? new Set(entries.map((entry) => entry.id)) : new Set())} /></TableHead><TableHead>Name / original path</TableHead><TableHead>Type</TableHead><TableHead>Deleted</TableHead><TableHead>Size</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
        <TableBody>{entries.map((entry) => <TableRow key={entry.id}>
          <TableCell><Checkbox aria-label={`Select ${trashName(entry)}`} checked={selected.has(entry.id)} disabled={blocked} onCheckedChange={() => toggle(entry.id)} /></TableCell>
          <TableCell className="max-w-md"><div className="flex items-center gap-2">{entry.type === "dir" ? <IconFolder className="size-4 shrink-0" /> : <IconFile className="size-4 shrink-0" />}<span className="truncate font-medium">{trashName(entry)}</span>{!entry.recoverable && <Badge variant="destructive">Damaged</Badge>}</div><p className="text-muted-foreground mt-1 break-all text-xs">{entry.originalPath || "Original path unavailable"}</p>{entry.error && <p className="text-destructive mt-1 break-words text-xs">{entry.error}</p>}</TableCell>
          <TableCell>{entry.type === "dir" ? "Folder" : entry.type === "file" ? "File" : "Unknown"}</TableCell>
          <TableCell className="whitespace-nowrap">{entry.deletedAt ? formatTime(entry.deletedAt) : "Unknown"}</TableCell>
          <TableCell className="whitespace-nowrap">{entry.size === 0 ? "0 B" : formatBytes(entry.size)}</TableCell>
          <TableCell><div className="flex justify-end gap-1"><Button variant="ghost" size="sm" disabled={blocked || !entry.recoverable} onClick={() => void restore([entry])}>Restore</Button><Button variant="ghost" size="sm" className="text-destructive" disabled={blocked} onClick={() => openPurge({ ids: [entry.id], phrase: "DELETE" })}>Delete forever</Button></div></TableCell>
        </TableRow>)}</TableBody>
      </Table>}
    </div>
    {busy && <p aria-live="polite" className="text-muted-foreground text-sm">Applying changes…</p>}

    <Dialog open={conflicts.length > 0} onOpenChange={(open) => !open && !busy && setConflicts([])}>
      <DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>Choose a different restore path</DialogTitle><DialogDescription>The original path already exists. Existing files will not be overwritten.</DialogDescription></DialogHeader>
        {conflicts[0] && <><p className="break-all text-sm">{conflicts[0].entry.originalPath}</p><Label htmlFor="restore-destination">New cloud path</Label><Input id="restore-destination" disabled={busy} value={conflicts[0].destination} onChange={(event) => setConflicts((current) => current.map((item, index) => index === 0 ? { ...item, destination: event.target.value, error: undefined } : item))} /><p className="text-muted-foreground text-xs">The destination folder must already exist. {conflicts.length > 1 && `${conflicts.length} conflicts remaining.`}</p>{conflicts[0].error && <p role="alert" className="text-destructive break-words text-sm">{conflicts[0].error}</p>}</>}
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setConflicts((current) => current.slice(1))}>Skip this item</Button><Button disabled={blocked || !conflicts[0]?.destination.trim()} onClick={() => void restoreConflict()}>Restore to this path</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={purge !== null} onOpenChange={(open) => !open && !busy && setPurge(null)}>
      <DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>{purge?.all ? "Empty trash permanently?" : "Delete selected items permanently?"}</DialogTitle><DialogDescription>This removes the stored files, including folder contents, and cannot be undone. A backup may not contain these items.</DialogDescription></DialogHeader>
        <Label htmlFor="purge-confirmation">Type {purge?.phrase} to confirm</Label><Input id="purge-confirmation" autoComplete="off" disabled={busy} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setPurge(null)}>Cancel</Button><Button variant="destructive" disabled={blocked || confirmation !== purge?.phrase} onClick={() => void purgeConfirmed()}>Delete permanently</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}
