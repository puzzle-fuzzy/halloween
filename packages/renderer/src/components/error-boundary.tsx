import * as React from "react"
import { Button } from "@halloween/ui/button"

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
      return (
        <div className="bg-background text-foreground flex min-h-screen flex-col items-center justify-center gap-3">
          <p className="text-destructive text-sm">{String(this.state.error)}</p>
          <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      )
    }
    return this.props.children
  }
}
