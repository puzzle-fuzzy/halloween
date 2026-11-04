/** public view of a stored Aliyun account — the secret never crosses the wire */
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
  type: "dir" | "file"
  size: number
  mtime: number
}
