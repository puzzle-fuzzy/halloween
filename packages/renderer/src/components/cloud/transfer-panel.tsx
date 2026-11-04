import * as React from "react"
import { IconDownload, IconUpload } from "@tabler/icons-react"
import { toast } from "sonner"

import { Button } from "@halloween/ui/button"
import { Progress } from "@/components/ui/progress"
import { mergeTransferSnapshots } from "@/lib/file-operations"
import type { TransferProgress } from "@/types/global"

export function TransferPanel() {
  const [items, setItems] = React.useState<TransferProgress[]>([])
  const [collapsed, setCollapsed] = React.useState(false)

  React.useEffect(() => {
    let active = true
    const cloud = window.electron?.cloud
    const unsubscribe = cloud?.onProgress((progress) => {
      setItems((previous) => mergeTransferSnapshots(previous, [progress]))
    })
    void cloud?.transfers().then((snapshot) => {
      if (active) setItems((current) => mergeTransferSnapshots(snapshot, current))
    }).catch(() => {})
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [])

  if (items.length === 0) return null
  const running = items.filter((item) => item.status === "running").length

  return (
    <div className="bg-background fixed right-4 bottom-4 z-40 flex w-80 flex-col gap-3 rounded-lg border p-3 shadow-lg">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">Transfers · {running} active</span>
        <Button variant="ghost" size="sm" className="ml-auto h-6 px-1 text-xs" onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? "Show" : "Hide"}
        </Button>
        {running < items.length && (
          <Button variant="ghost" size="sm" className="h-6 px-1 text-xs" onClick={() => setItems((previous) => previous.filter((item) => item.status === "running"))}>
            Clear finished
          </Button>
        )}
      </div>
      {!collapsed && <div className="flex max-h-80 flex-col gap-3 overflow-auto">
      {items.map((item) => {
        const pct = item.status === "completed" ? 100 : item.total > 0 ? Math.min(100, Math.round((item.loaded / item.total) * 100)) : 0
        return (
          <div key={item.id} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 text-xs">
              {item.kind === "upload" ? <IconUpload className="text-muted-foreground size-3.5" /> : <IconDownload className="text-muted-foreground size-3.5" />}
              <span className="truncate" title={item.name}>{item.name}</span>
              <span className="text-muted-foreground ml-auto shrink-0 tabular-nums">
                {item.status === "failed" ? "Failed" : item.status === "cancelled" ? "Cancelled" : item.status === "completed" ? "Completed" : pct >= 100 ? "Finishing…" : `${pct}%`}
              </span>
              {item.status === "running" && <Button variant="ghost" size="sm" className="h-6 px-1 text-xs" onClick={() => void window.electron?.cloud?.cancelTransfer(item.id).catch((error) => toast.error(String(error)))}>Cancel</Button>}
            </div>
            <Progress value={pct} className="h-1.5" />
            {item.error && <p className="text-destructive break-words text-xs">{item.error}</p>}
          </div>
        )
      })}
      </div>}
    </div>
  )
}
