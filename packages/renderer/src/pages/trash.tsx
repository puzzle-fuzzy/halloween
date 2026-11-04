import { Badge } from "@halloween/ui/badge"
import { Button } from "@halloween/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@halloween/ui/card"
import { Checkbox } from "@halloween/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@halloween/ui/dialog"
import { Input } from "@halloween/ui/input"
import { Label } from "@halloween/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@halloween/ui/table"
import { IconArrowBackUp, IconFile, IconFolder, IconRefresh, IconTrash } from "@tabler/icons-react"
import * as React from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { useCloudAuth } from "@/components/cloud/auth"
import { useI18n } from "@/i18n"
import { createRequestTracker } from "@/lib/file-operations"
import { formatBytes, formatTime } from "@/lib/format"
import {
  alternativeRestorePath,
  isRestoreConflict,
  selectedRecoverable,
  trashName,
  validRestorePath,
} from "@/lib/storage-maintenance"
import type { TrashEntry, TrashListing, TrashPurgeInput } from "@/types/global"

interface RestoreConflict {
  entry: TrashEntry
  destination: string
  error?: string
}
interface PurgeIntent {
  ids?: string[]
  all?: boolean
  phrase: TrashPurgeInput["confirmation"]
}

export default function TrashPage() {
  const auth = useCloudAuth()
  const { t } = useI18n()
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
      setListing(null)
      setSelected(new Set())
      setConflicts([])
      setPurge(null)
      setFailures([])
      setWarnings([])
      setPurgeNotice("")
      setPurgeFailures([])
    }
    return () => {
      mounted.current = false
      lifecycle.current += 1
      requests.invalidate()
    }
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
        } catch (e) {
          if (!current()) break
          handleError(e)
          if (isRestoreConflict(e))
            pending.push({ entry, destination: alternativeRestorePath(entry) })
          else failed.push(`${trashName(entry)}: ${String(e)}`)
        }
      }
      if (!current()) return
      if (restored) toast.success(t.trash.restoredN(restored))
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
      setConflicts((current) =>
        current.map((item, index) =>
          index === 0 ? { ...item, error: t.trash.invalidPath } : item,
        ),
      )
      return
    }
    const operation = lifecycle.current
    const current = () => mounted.current && lifecycle.current === operation
    setBusy(true)
    try {
      const result = await cloud.restoreTrash(conflict.entry.id, destination)
      if (!current()) return
      toast.success(t.trash.restoredTo(result.path))
      if (result.warning) setWarnings((current) => [...current, result.warning!])
      setConflicts((current) => current.slice(1))
      await load()
    } catch (e) {
      if (!current()) return
      handleError(e)
      const message = isRestoreConflict(e) ? t.trash.pathExists : String(e)
      setConflicts((current) =>
        current.map((item, index) => (index === 0 ? { ...item, error: message } : item)),
      )
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
      const result = await cloud.purgeTrash({
        ids: purge.ids,
        all: purge.all,
        confirmation: purge.phrase,
      })
      if (!current()) return
      if (!result.ok || result.failed?.length) {
        setPurgeNotice(t.trash.purgePartial(result.purged))
        setPurgeFailures(
          (result.failed ?? []).map((failure) => {
            const entry = listing?.entries.find((item) => item.id === failure.id)
            return `${entry ? trashName(entry) : failure.id}: ${failure.error}`
          }),
        )
        toast.warning(t.trash.purgeSomeFailed)
      } else toast.success(t.trash.purgedN(result.purged))
    } catch (e) {
      if (!current()) return
      handleError(e)
      setPurgeNotice(t.trash.purgeUncertain)
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
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  if (!auth.authed)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm">
        <p>
          {auth.error || (auth.authed === null ? t.common.checkingConnection : t.trash.signInTitle)}
        </p>
        {auth.authed === null && auth.error ? (
          <Button variant="outline" onClick={() => void auth.retry()}>
            {t.common.retryConnection}
          </Button>
        ) : (
          auth.authed === false && (
            <Button asChild>
              <Link to="/cloud">{t.common.signInCloud}</Link>
            </Button>
          )
        )}
      </div>
    )

  return (
    <div className="flex flex-1 flex-col gap-5 p-4 lg:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{t.trash.title}</h2>
          <p className="text-muted-foreground mt-1 text-sm">{t.trash.subtitle}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={blocked} onClick={() => void load()}>
            <IconRefresh />
            {t.common.refresh}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={blocked || !entries.length}
            onClick={() => openPurge({ all: true, phrase: "EMPTY_TRASH" })}
          >
            <IconTrash />
            {t.trash.emptyTrash}
          </Button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>{t.trash.deletedItems}</CardDescription>
            <CardTitle>{listing ? entries.length : "—"}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>{t.trash.recoverableItems}</CardDescription>
            <CardTitle>
              {listing ? entries.filter((entry) => entry.recoverable).length : "—"}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>
              {listing?.incomplete ? t.trash.storageKnown : t.trash.storageTrash}
            </CardDescription>
            <CardTitle>
              {listing ? (listing.totalBytes === 0 ? "0 B" : formatBytes(listing.totalBytes)) : "—"}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>
      {listing?.incomplete && (
        <p role="status" className="rounded-lg border p-3 text-sm">
          {t.trash.incompleteNotice}
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm"
        >
          <p className="text-destructive break-words">{error}</p>
          <Button variant="outline" size="sm" disabled={blocked} onClick={() => void load()}>
            {t.common.retry}
          </Button>
        </div>
      )}
      {failures.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t.trash.restoreSomeFailed}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm text-destructive">
              {failures.map((message, index) => (
                <li key={index} className="break-words">
                  {message}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {warnings.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t.trash.restoredWithWarning}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul role="status" className="space-y-1 text-sm">
              {warnings.map((message, index) => (
                <li key={index} className="break-words">
                  {message}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {purgeNotice && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t.trash.purgeReview}</CardTitle>
          </CardHeader>
          <CardContent role="alert" className="space-y-2 text-sm">
            <p>{purgeNotice}</p>
            {purgeFailures.length > 0 && (
              <ul className="space-y-1 text-destructive">
                {purgeFailures.map((message, index) => (
                  <li key={index} className="break-words">
                    {message}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
          <span>{t.common.selected(selected.size)}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={blocked || !recoverable.length}
            onClick={() => void restore(recoverable)}
          >
            <IconArrowBackUp />
            {t.trash.restoreN(recoverable.length)}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={blocked}
            onClick={() => openPurge({ ids: [...selected], phrase: "DELETE" })}
          >
            {t.trash.permanentlyDelete}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={blocked}
            onClick={() => setSelected(new Set())}
          >
            {t.trash.clearSelection}
          </Button>
          {recoverable.length < selected.size && (
            <span className="text-muted-foreground">{t.trash.damagedExcluded}</span>
          )}
        </div>
      )}
      <div className="min-h-40 overflow-auto rounded-lg border">
        {loading && !listing ? (
          <p className="text-muted-foreground p-6 text-sm">{t.trash.loadingFiles}</p>
        ) : entries.length === 0 ? (
          <p className="text-muted-foreground p-6 text-sm">
            {error ? t.trash.loadFailed : t.trash.empty}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    aria-label={t.trash.selectAllAria}
                    checked={allSelected}
                    disabled={blocked}
                    onCheckedChange={(checked) =>
                      setSelected(
                        checked === true ? new Set(entries.map((entry) => entry.id)) : new Set(),
                      )
                    }
                  />
                </TableHead>
                <TableHead>{t.trash.nameOriginalPath}</TableHead>
                <TableHead>{t.common.type}</TableHead>
                <TableHead>{t.trash.deleted}</TableHead>
                <TableHead>{t.common.size}</TableHead>
                <TableHead className="text-right">{t.common.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>
                    <Checkbox
                      aria-label={t.oss.selectEntry(trashName(entry))}
                      checked={selected.has(entry.id)}
                      disabled={blocked}
                      onCheckedChange={() => toggle(entry.id)}
                    />
                  </TableCell>
                  <TableCell className="max-w-md">
                    <div className="flex items-center gap-2">
                      {entry.type === "dir" ? (
                        <IconFolder className="size-4 shrink-0" />
                      ) : (
                        <IconFile className="size-4 shrink-0" />
                      )}
                      <span className="truncate font-medium">{trashName(entry)}</span>
                      {!entry.recoverable && <Badge variant="destructive">{t.trash.damaged}</Badge>}
                    </div>
                    <p className="text-muted-foreground mt-1 break-all text-xs">
                      {entry.originalPath || t.trash.originalUnavailable}
                    </p>
                    {entry.error && (
                      <p className="text-destructive mt-1 break-words text-xs">{entry.error}</p>
                    )}
                  </TableCell>
                  <TableCell>
                    {entry.type === "dir"
                      ? t.common.folder
                      : entry.type === "file"
                        ? t.common.file
                        : t.common.unknown}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {entry.deletedAt ? formatTime(entry.deletedAt) : t.common.unknown}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {entry.size === 0 ? "0 B" : formatBytes(entry.size)}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={blocked || !entry.recoverable}
                        onClick={() => void restore([entry])}
                      >
                        {t.trash.restore}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        disabled={blocked}
                        onClick={() => openPurge({ ids: [entry.id], phrase: "DELETE" })}
                      >
                        {t.common.deleteForever}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      {busy && (
        <p aria-live="polite" className="text-muted-foreground text-sm">
          {t.trash.applyingChanges}
        </p>
      )}

      <Dialog
        open={conflicts.length > 0}
        onOpenChange={(open) => !open && !busy && setConflicts([])}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t.trash.choosePathTitle}</DialogTitle>
            <DialogDescription>{t.trash.choosePathDesc}</DialogDescription>
          </DialogHeader>
          {conflicts[0] && (
            <>
              <p className="break-all text-sm">{conflicts[0].entry.originalPath}</p>
              <Label htmlFor="restore-destination">{t.trash.newPath}</Label>
              <Input
                id="restore-destination"
                disabled={busy}
                value={conflicts[0].destination}
                onChange={(event) =>
                  setConflicts((current) =>
                    current.map((item, index) =>
                      index === 0
                        ? { ...item, destination: event.target.value, error: undefined }
                        : item,
                    ),
                  )
                }
              />
              <p className="text-muted-foreground text-xs">
                {t.trash.destMustExist}{" "}
                {conflicts.length > 1 && t.trash.conflictsRemaining(conflicts.length)}
              </p>
              {conflicts[0].error && (
                <p role="alert" className="text-destructive break-words text-sm">
                  {conflicts[0].error}
                </p>
              )}
            </>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setConflicts((current) => current.slice(1))}
            >
              {t.trash.skipItem}
            </Button>
            <Button
              disabled={blocked || !conflicts[0]?.destination.trim()}
              onClick={() => void restoreConflict()}
            >
              {t.trash.restoreToPath}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={purge !== null} onOpenChange={(open) => !open && !busy && setPurge(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {purge?.all ? t.trash.emptyTitle : t.trash.deleteSelectedTitle}
            </DialogTitle>
            <DialogDescription>{t.trash.purgeDesc}</DialogDescription>
          </DialogHeader>
          <Label htmlFor="purge-confirmation">{t.trash.typePhrase(purge?.phrase ?? "")}</Label>
          <Input
            id="purge-confirmation"
            autoComplete="off"
            disabled={busy}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setPurge(null)}>
              {t.common.cancel}
            </Button>
            <Button
              variant="destructive"
              disabled={blocked || confirmation !== purge?.phrase}
              onClick={() => void purgeConfirmed()}
            >
              {t.trash.deletePermanently}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
