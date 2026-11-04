/** one entry of a cloud-drive directory listing (server files.ts ↔ renderer cloud page) */
export interface FileEntry {
  name: string
  type: "dir" | "file"
  size: number
  mtime: number
  path: string
}
