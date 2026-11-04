import { Button } from "@halloween/ui/button"
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
import { IconPencil, IconPlus, IconTrash } from "@tabler/icons-react"
import * as React from "react"
import { useI18n } from "@/i18n"
import { adminApi } from "@/lib/api"

interface Account {
  id: string
  name: string
  region: string
}

interface DialogState {
  mode: "create" | "edit"
  id?: string
  name: string
  region: string
  accessKeyId: string
  accessKeySecret: string
}

const emptyDialog: DialogState = {
  mode: "create",
  name: "",
  region: "",
  accessKeyId: "",
  accessKeySecret: "",
}

export default function OssAccountsPage() {
  const { t } = useI18n()
  const [accounts, setAccounts] = React.useState<Account[] | null>(null)
  const [dialog, setDialog] = React.useState<DialogState | null>(null)
  const [error, setError] = React.useState("")
  const [loadError, setLoadError] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      setLoadError("")
      const res = await adminApi<{ accounts: Account[] }>("/oss-accounts")
      setAccounts(res.accounts)
    } catch (e) {
      setLoadError(String(e))
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const save = async () => {
    if (!dialog || busy) return
    setBusy(true)
    setError("")
    const body = {
      id: dialog.id,
      name: dialog.name.trim(),
      region: dialog.region.trim(),
      accessKeyId: dialog.accessKeyId.trim(),
      accessKeySecret: dialog.accessKeySecret.trim(),
    }
    try {
      if (dialog.mode === "create") {
        await adminApi("/oss-accounts", { method: "POST", body: JSON.stringify(body) })
      } else {
        await adminApi("/oss-accounts/update", { method: "POST", body: JSON.stringify(body) })
      }
      setDialog(null)
      void load()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (account: Account) => {
    if (busy) return
    if (!window.confirm(t.oss.deleteConfirm(account.name))) return
    setBusy(true)
    try {
      await adminApi("/oss-accounts/delete", {
        method: "POST",
        body: JSON.stringify({ id: account.id }),
      })
      await load()
    } catch (e) {
      setLoadError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const fields: { key: keyof DialogState; label: string; placeholder: string; secret?: boolean }[] =
    [
      { key: "name", label: t.common.name, placeholder: t.oss.namePlaceholder },
      { key: "region", label: t.oss.region, placeholder: t.oss.regionPlaceholder },
      { key: "accessKeyId", label: t.oss.accessKeyId, placeholder: "LTAI…" },
      { key: "accessKeySecret", label: t.oss.accessKeySecret, placeholder: "", secret: true },
    ]

  return (
    <div className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:px-6">
      <div className="flex items-center">
        <p className="text-muted-foreground text-sm">{t.oss.description}</p>
        <Button
          size="sm"
          className="ml-auto"
          disabled={busy}
          onClick={() => {
            setError("")
            setDialog({ ...emptyDialog })
          }}
        >
          <IconPlus />
          {t.oss.addAccount}
        </Button>
      </div>
      {loadError && (
        <div role="alert" className="flex items-center justify-between gap-4 text-sm">
          <p className="text-destructive">{loadError}</p>
          <Button variant="outline" onClick={() => void load()}>
            {t.common.retry}
          </Button>
        </div>
      )}
      <div className="flex-1 overflow-hidden rounded-lg border">
        {accounts === null ? (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            {loadError ? t.oss.loadFailed : t.common.loading}
          </div>
        ) : accounts.length === 0 ? (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            {t.oss.empty}
          </div>
        ) : (
          <div className="h-full overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-3">{t.common.name}</TableHead>
                  <TableHead className="w-48">{t.oss.region}</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((account) => (
                  <TableRow key={account.id}>
                    <TableCell className="pl-3 font-medium">{account.name}</TableCell>
                    <TableCell className="text-muted-foreground">{account.region}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label={t.common.edit}
                          disabled={busy}
                          onClick={() => {
                            setError("")
                            setDialog({
                              mode: "edit",
                              id: account.id,
                              name: account.name,
                              region: account.region,
                              accessKeyId: "",
                              accessKeySecret: "",
                            })
                          }}
                        >
                          <IconPencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive size-7"
                          aria-label={t.common.delete}
                          disabled={busy}
                          onClick={() => void remove(account)}
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

      <Dialog open={dialog !== null} onOpenChange={(o) => !o && !busy && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {dialog?.mode === "create" ? t.oss.addTitle : t.oss.editTitle}
            </DialogTitle>
          </DialogHeader>
          <fieldset disabled={busy} className="flex flex-col gap-4">
            {fields.map((f) => (
              <div key={f.key} className="flex flex-col gap-2">
                <Label htmlFor={`oss-${f.key}`}>
                  {f.label}
                  {dialog?.mode === "edit" && f.secret ? t.oss.secretKeep : ""}
                </Label>
                <Input
                  id={`oss-${f.key}`}
                  type={f.secret ? "password" : "text"}
                  placeholder={f.placeholder}
                  value={String(dialog?.[f.key] ?? "")}
                  onChange={(e) => dialog && setDialog({ ...dialog, [f.key]: e.target.value })}
                />
              </div>
            ))}
            {error && <p className="text-destructive text-sm">{error}</p>}
          </fieldset>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setDialog(null)}>
              {t.common.cancel}
            </Button>
            <Button
              onClick={() => void save()}
              disabled={
                busy ||
                !dialog?.name.trim() ||
                !dialog?.region.trim() ||
                (dialog.mode === "create" &&
                  (!dialog.accessKeyId.trim() || !dialog.accessKeySecret.trim()))
              }
            >
              {busy ? t.common.saving : dialog?.mode === "create" ? t.common.add : t.common.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
