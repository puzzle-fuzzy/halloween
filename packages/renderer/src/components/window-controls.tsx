import { useEffect, useState } from "react"
import { IconCopy, IconMinus, IconSquare, IconX } from "@tabler/icons-react"

export function WindowControls() {
  const api = window.electron?.window
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!api) return
    let mounted = true
    api.isMaximized().then((value) => {
      if (mounted) setMaximized(value)
    })
    return api.onMaximizeChange((value) => setMaximized(value))
  }, [api])

  if (!api) return null

  const button =
    "inline-flex w-11 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"

  return (
    <div className="flex items-stretch [-webkit-app-region:no-drag]">
      <button
        type="button"
        aria-label="Minimize"
        className={button}
        onClick={api.minimize}
      >
        <IconMinus className="size-4" />
      </button>
      <button
        type="button"
        aria-label={maximized ? "Restore" : "Maximize"}
        className={button}
        onClick={api.toggleMaximize}
      >
        {maximized ? (
          <IconCopy className="size-3.5" />
        ) : (
          <IconSquare className="size-3.5" />
        )}
      </button>
      <button
        type="button"
        aria-label="Close"
        className={`${button} hover:bg-destructive hover:text-white`}
        onClick={api.close}
      >
        <IconX className="size-4" />
      </button>
    </div>
  )
}
