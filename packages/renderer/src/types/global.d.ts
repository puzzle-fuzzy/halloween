export {}

declare global {
  interface Window {
    electron?: {
      versions: { chrome: string; node: string; electron: string }
      window?: {
        minimize: () => void
        toggleMaximize: () => void
        close: () => void
        isMaximized: () => Promise<boolean>
        onMaximizeChange: (callback: (maximized: boolean) => void) => () => void
      }
    }
  }
}
