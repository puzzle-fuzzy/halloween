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

export interface OssAccountInfo {
  id: string
  name: string
  region: string
}

export interface OssBucketInfo {
  name: string
  region?: string
  createdAt: number
}

export interface OssEntry {
  name: string
  key: string
  type: 'dir' | 'file'
  size: number
  mtime: number
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
      oss?: {
        accounts: () => Promise<{ accounts: OssAccountInfo[] }>
        buckets: (accountId: string) => Promise<{ buckets: OssBucketInfo[] }>
        objects: (
          accountId: string,
          bucket: string,
          prefix: string
        ) => Promise<{ entries: OssEntry[]; truncated: boolean }>
        previewUrl: (accountId: string, bucket: string, key: string) => Promise<{ url: string }>
        mkdir: (accountId: string, bucket: string, key: string) => Promise<unknown>
        rename: (accountId: string, bucket: string, from: string, to: string) => Promise<unknown>
        remove: (accountId: string, bucket: string, keys: string[]) => Promise<unknown>
        pickAndUpload: (
          accountId: string,
          bucket: string,
          prefix: string
        ) => Promise<{ name: string; size: number }[]>
        uploadFiles: (
          accountId: string,
          bucket: string,
          prefix: string,
          localPaths: string[]
        ) => Promise<{ name: string; size: number }[]>
        downloadTo: (
          accountId: string,
          bucket: string,
          key: string,
          name: string,
          targetDir: string
        ) => Promise<string>
      }
      cloud?: {
        login: () => Promise<{ ok: boolean }>
        logout: () => Promise<void>
        isAuthed: () => Promise<boolean>
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
