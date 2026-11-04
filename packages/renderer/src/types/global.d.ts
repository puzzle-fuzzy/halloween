import type {
  BackupJob,
  BackupJobKind,
  BackupStatus,
  FileEntry as CloudEntry,
  OssAccountInfo,
  OssBucketInfo,
  OssEntry,
  RssItem,
  TransferProgress,
  TrashListing,
  TrashPurgeInput,
  TrashPurgeResult,
} from "@halloween/contracts"

export type {
  BackupJob,
  BackupJobKind,
  BackupSnapshot,
  BackupStartInput,
  BackupStatus,
  FileEntry,
  OssAccountInfo,
  OssBucketInfo,
  OssEntry,
  RssFeed,
  RssItem,
  TransferProgress,
  TrashEntry,
  TrashListing,
  TrashPurgeInput,
  TrashPurgeResult,
  TrashRestoreResult,
} from "@halloween/contracts"

export type { CloudEntry }

export interface CloudConfig {
  serverUrl: string
  token: string
}

export interface ProxySubscriptionInfo {
  id: string
  name: string
  url: string
  updatedAt: number
  nodeCount: number
}

export interface ProxyState {
  /** sys-proxy: windows + macos; false elsewhere */
  supported: boolean
  /** TUN needs windows elevation machinery */
  tunSupported: boolean
  running: boolean
  busy: boolean
  sysProxy: boolean
  mode: "sys" | "tun"
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
          prefix: string,
          marker?: string,
        ) => Promise<{ entries: OssEntry[]; truncated: boolean; nextMarker?: string }>
        previewUrl: (accountId: string, bucket: string, key: string) => Promise<{ url: string }>
        mkdir: (accountId: string, bucket: string, key: string) => Promise<unknown>
        rename: (accountId: string, bucket: string, from: string, to: string) => Promise<unknown>
        remove: (accountId: string, bucket: string, keys: string[]) => Promise<unknown>
        pickAndUpload: (
          accountId: string,
          bucket: string,
          prefix: string,
        ) => Promise<{ name: string; size: number }[]>
        uploadFiles: (
          accountId: string,
          bucket: string,
          prefix: string,
          localPaths: string[],
        ) => Promise<{ name: string; size: number }[]>
        downloadTo: (
          accountId: string,
          bucket: string,
          key: string,
          name: string,
          targetDir: string,
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
        setMode: (mode: "sys" | "tun") => Promise<ProxyState>
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
          }) => void,
        ) => () => void
      }
      cloud?: {
        login: () => Promise<{ ok: boolean }>
        logout: () => Promise<void>
        isAuthed: () => Promise<boolean>
        openAdmin: (page?: "profile" | "tokens" | "oss-accounts") => Promise<void>
        transfers: () => Promise<TransferProgress[]>
        cancelTransfer: (id: string) => Promise<void>
        onAuthCode: (
          callback: (code: { userCode: string; expiresAt: number }) => void,
        ) => () => void
        profile: () => Promise<{
          profile: { name: string; email: string; avatar: string }
        }>
        list: (dir: string) => Promise<{ entries: CloudEntry[] }>
        listTrash: () => Promise<TrashListing>
        restoreTrash: (
          id: string,
          destination?: string,
        ) => Promise<{ ok: true; path: string; warning?: string }>
        purgeTrash: (input: TrashPurgeInput) => Promise<TrashPurgeResult>
        backupStatus: () => Promise<BackupStatus>
        startBackupJob: (input: { kind: BackupJobKind; snapshotId?: string }) => Promise<BackupJob>
        backupJob: (id: string) => Promise<BackupJob>
        mkdir: (dir: string) => Promise<unknown>
        rename: (from: string, to: string) => Promise<unknown>
        remove: (paths: string[]) => Promise<unknown>
        search: (q: string) => Promise<{ entries: CloudEntry[] }>
        fileUrl: (remotePath: string) => Promise<string>
        pickAndUpload: (remoteDir: string) => Promise<{ name: string; size: number }[]>
        uploadFiles: (
          localPaths: string[],
          remoteDir: string,
        ) => Promise<{ name: string; size: number }[]>
        chooseDownloadDir: () => Promise<string | null>
        downloadTo: (remotePath: string, name: string, targetDir: string) => Promise<string>
        onProgress: (callback: (progress: TransferProgress) => void) => () => void
      }
      updater?: {
        check: () => Promise<{
          current: string
          latest: string | null
          available: boolean | null
          reason?: "private-repo" | "network"
        }>
        openReleases: () => Promise<void>
        onUpdateAvailable: (
          callback: (result: { current: string; latest: string; available: boolean }) => void,
        ) => () => void
      }
      getPathForFile?: (file: File) => string
    }
  }
}
