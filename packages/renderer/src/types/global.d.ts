export {}

export interface CloudEntry {
  name: string
  type: 'dir' | 'file'
  size: number
  mtime: number
  path: string
}

export interface CloudConfig {
  serverUrl: string
  token: string
}

export interface TransferProgress {
  id: string
  kind: 'upload' | 'download'
  name: string
  loaded: number
  total: number
}

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
      cloud?: {
        getConfig: () => Promise<CloudConfig>
        setConfig: (config: CloudConfig) => Promise<void>
        list: (dir: string) => Promise<{ entries: CloudEntry[] }>
        mkdir: (dir: string) => Promise<unknown>
        rename: (from: string, to: string) => Promise<unknown>
        remove: (paths: string[]) => Promise<unknown>
        search: (q: string) => Promise<{ entries: CloudEntry[] }>
        fileUrl: (remotePath: string) => Promise<string>
        pickAndUpload: (remoteDir: string) => Promise<{ name: string; size: number }[]>
        uploadFiles: (localPaths: string[], remoteDir: string) => Promise<{ name: string; size: number }[]>
        chooseDownloadDir: () => Promise<string | null>
        downloadTo: (remotePath: string, name: string, targetDir: string) => Promise<string>
        onProgress: (callback: (progress: TransferProgress) => void) => () => void
      }
      getPathForFile?: (file: File) => string
    }
  }
}
