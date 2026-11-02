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

export interface RssItem {
  id: string
  feedId: string
  feedTitle: string
  title: string
  link: string
  publishedAt: number
  summary: string
}

export interface ProxySubscriptionInfo {
  id: string
  name: string
  url: string
  updatedAt: number
  nodeCount: number
}

export interface ProxyState {
  running: boolean
  busy: boolean
  sysProxy: boolean
  mode: 'sys' | 'tun'
  tunReady: boolean
  mixedPort: number
  subscriptions: ProxySubscriptionInfo[]
  nodeCount: number
  cachedNodes: string[]
  lastError: string
}

export interface ProxyNodes {
  current: string
  nodes: { name: string; delay: number }[]
}

declare global {
  interface Window {
    electron?: {
      versions: { chrome: string; node: string; electron: string }
      platform: string
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
      rss?: {
        items: (limit?: number) => Promise<{ refreshedAt: number; items: RssItem[] }>
        open: (url: string) => Promise<void>
      }
      proxy?: {
        state: () => Promise<ProxyState>
        enable: () => Promise<ProxyState>
        disable: () => Promise<ProxyState>
        setMode: (mode: 'sys' | 'tun') => Promise<ProxyState>
        installTun: () => Promise<ProxyState>
        addSubscription: (url: string) => Promise<ProxyState>
        deleteSubscription: (id: string) => Promise<ProxyState>
        updateSubscription: (id: string) => Promise<ProxyState>
        nodes: () => Promise<ProxyNodes>
        select: (name: string) => Promise<ProxyNodes>
        testAll: () => Promise<ProxyNodes>
        onTraffic: (
          callback: (sample: {
            up: number
            down: number
            upTotal: number
            downTotal: number
            ts: number
          }) => void
        ) => () => void
      }
      cloud?: {
        login: () => Promise<{ ok: boolean }>
        logout: () => Promise<void>
        isAuthed: () => Promise<boolean>
        profile: () => Promise<{
          profile: { name: string; email: string; avatar: string }
        }>
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
