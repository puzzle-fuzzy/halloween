import * as React from "react"
import { Button } from "@halloween/ui/button"

import { useI18n } from "@/i18n"

interface State {
  error: Error | null
}

/** keeps a render crash from bricking the window: shows a reload button */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (this.state.error) {
      return <CrashScreen error={this.state.error} />
    }
    return this.props.children
  }
}

function CrashScreen({ error }: { error: Error }) {
  const { t } = useI18n()
  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col items-center justify-center gap-3">
      <p className="text-destructive text-sm">{String(error)}</p>
      <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
        {t.common.reload}
      </Button>
    </div>
  )
}
