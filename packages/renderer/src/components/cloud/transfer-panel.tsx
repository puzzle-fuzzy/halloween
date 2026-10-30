import * as React from "react"
import { IconDownload, IconUpload, IconX } from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import type { TransferProgress } from "@/types/global"

export function TransferPanel() {
  const [items, setItems] = React.useState<TransferProgress[]>([])

  React.useEffect(() => {
    const unsubscribe = window.electron?.cloud?.onProgress((p) => {
      setItems((prev) => {
        const next = prev.filter((i) => i.id !== p.id)
        if (p.loaded >= p.total) {
          // finished: hold briefly? main sends final tick; drop immediately is fine
          return next
        }
        return [...next, p].slice(-20)
      })
    })
    return unsubscribe
  }, [])

  if (items.length === 0) return null

  return (
    <div className="bg-background fixed right-4 bottom-4 z-40 flex w-80 flex-col gap-3 rounded-lg border p-3 shadow-lg">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs">Transfers {items.length}</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={() => setItems([])}
        >
          <IconX className="size-3.5" />
        </Button>
      </div>
      {items.map((item) => {
        const pct = item.total > 0 ? Math.round((item.loaded / item.total) * 100) : 0
        return (
          <div key={item.id} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 text-xs">
              {item.kind === "upload" ? (
                <IconUpload className="text-muted-foreground size-3.5" />
              ) : (
                <IconDownload className="text-muted-foreground size-3.5" />
              )}
              <span className="truncate">{item.name}</span>
              <span className="text-muted-foreground ml-auto tabular-nums">{pct}%</span>
            </div>
            <Progress value={pct} className="h-1.5" />
          </div>
        )
      })}
    </div>
  )
}
