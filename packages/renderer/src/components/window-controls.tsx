import { IconCopy, IconMinus, IconSquare, IconX } from "@tabler/icons-react"
import { useEffect, useState } from "react"
import { useI18n } from "@/i18n"

export function WindowControls() {
  const api = window.electron?.window
  const { t } = useI18n()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!api) return
    const mounted = true
    api.isMaximized().then((value) => {
      if (mounted) setMaximized(value)
    })
    return api.onMaximizeChange((value) => setMaximized(value))
  }, [api])

  // mac uses the native traffic lights; windows/linux use these in-app buttons
  if (!api || window.electron?.platform === "darwin") return null

  // wrap bridge calls: passing api.minimize straight as onClick would forward
  // the React SyntheticEvent across the context bridge, which cannot be cloned
  const button =
    "inline-flex w-11 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"

  return (
    <div className="flex items-stretch [-webkit-app-region:no-drag]">
      <button
        type="button"
        aria-label={t.window.minimize}
        className={button}
        onClick={() => api.minimize()}
      >
        <IconMinus className="size-4" />
      </button>
      <button
        type="button"
        aria-label={maximized ? t.window.restore : t.window.maximize}
        className={button}
        onClick={() => api.toggleMaximize()}
      >
        {maximized ? <IconCopy className="size-3.5" /> : <IconSquare className="size-3.5" />}
      </button>
      <button
        type="button"
        aria-label={t.window.close}
        className={`${button} hover:bg-destructive hover:text-white`}
        onClick={() => api.close()}
      >
        <IconX className="size-4" />
      </button>
    </div>
  )
}
