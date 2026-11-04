/** live upload/download job state surfaced through the transfer panel */
export interface TransferProgress {
  id: string
  kind: 'upload' | 'download'
  name: string
  loaded: number
  total: number
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  error?: string
}
