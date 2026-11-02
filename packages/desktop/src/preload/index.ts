import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('electron', {
  versions: process.versions,
  platform: process.platform,
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizeChange: (callback: (maximized: boolean) => void) => {
      const listener = (_event: unknown, maximized: boolean) => callback(maximized)
      ipcRenderer.on('window:maximize-changed', listener)
      return () => ipcRenderer.removeListener('window:maximize-changed', listener)
    },
  },
  cloud: {
    login: () => ipcRenderer.invoke('cloud:login'),
    logout: () => ipcRenderer.invoke('cloud:logout'),
    isAuthed: () => ipcRenderer.invoke('cloud:is-authed'),
    profile: () => ipcRenderer.invoke('cloud:profile'),
    list: (dir: string) => ipcRenderer.invoke('cloud:list', dir),
    mkdir: (dir: string) => ipcRenderer.invoke('cloud:mkdir', dir),
    rename: (from: string, to: string) => ipcRenderer.invoke('cloud:rename', from, to),
    remove: (paths: string[]) => ipcRenderer.invoke('cloud:delete', paths),
    search: (q: string) => ipcRenderer.invoke('cloud:search', q),
    fileUrl: (remotePath: string) => ipcRenderer.invoke('cloud:file-url', remotePath),
    pickAndUpload: (remoteDir: string) => ipcRenderer.invoke('cloud:pick-and-upload', remoteDir),
    uploadFiles: (localPaths: string[], remoteDir: string) =>
      ipcRenderer.invoke('cloud:upload-files', localPaths, remoteDir),
    chooseDownloadDir: () => ipcRenderer.invoke('cloud:choose-download-dir'),
    downloadTo: (remotePath: string, name: string, targetDir: string) =>
      ipcRenderer.invoke('cloud:download-to', remotePath, name, targetDir),
    onProgress: (
      callback: (progress: {
        id: string
        kind: 'upload' | 'download'
        name: string
        loaded: number
        total: number
      }) => void
    ) => {
      const listener = (_event: unknown, progress: unknown) => callback(progress as never)
      ipcRenderer.on('cloud:progress', listener)
      return () => ipcRenderer.removeListener('cloud:progress', listener)
    },
  },
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  oss: {
    accounts: () => ipcRenderer.invoke('oss:accounts'),
    buckets: (accountId: string) => ipcRenderer.invoke('oss:buckets', accountId),
    objects: (accountId: string, bucket: string, prefix: string) =>
      ipcRenderer.invoke('oss:objects', accountId, bucket, prefix),
    previewUrl: (accountId: string, bucket: string, key: string) =>
      ipcRenderer.invoke('oss:preview-url', accountId, bucket, key),
    mkdir: (accountId: string, bucket: string, key: string) =>
      ipcRenderer.invoke('oss:mkdir', accountId, bucket, key),
    rename: (accountId: string, bucket: string, from: string, to: string) =>
      ipcRenderer.invoke('oss:rename', accountId, bucket, from, to),
    remove: (accountId: string, bucket: string, keys: string[]) =>
      ipcRenderer.invoke('oss:delete', accountId, bucket, keys),
    pickAndUpload: (accountId: string, bucket: string, prefix: string) =>
      ipcRenderer.invoke('oss:pick-and-upload', accountId, bucket, prefix),
    uploadFiles: (accountId: string, bucket: string, prefix: string, localPaths: string[]) =>
      ipcRenderer.invoke('oss:upload-files', accountId, bucket, prefix, localPaths),
    downloadTo: (accountId: string, bucket: string, key: string, name: string, targetDir: string) =>
      ipcRenderer.invoke('oss:download-to', accountId, bucket, key, name, targetDir),
  },
  rss: {
    items: (limit?: number) => ipcRenderer.invoke('rss:items', limit),
    open: (url: string) => ipcRenderer.invoke('rss:open', url),
  },
  proxy: {
    state: () => ipcRenderer.invoke('proxy:state'),
    enable: () => ipcRenderer.invoke('proxy:enable'),
    disable: () => ipcRenderer.invoke('proxy:disable'),
    setMode: (mode: 'sys' | 'tun') => ipcRenderer.invoke('proxy:set-mode', mode),
    installTun: () => ipcRenderer.invoke('proxy:install-tun'),
    addSubscription: (url: string) => ipcRenderer.invoke('proxy:subs:add', url),
    deleteSubscription: (id: string) => ipcRenderer.invoke('proxy:subs:delete', id),
    updateSubscription: (id: string) => ipcRenderer.invoke('proxy:subs:update', id),
    nodes: () => ipcRenderer.invoke('proxy:nodes'),
    select: (name: string) => ipcRenderer.invoke('proxy:select', name),
    testAll: () => ipcRenderer.invoke('proxy:test-all'),
  },
})
