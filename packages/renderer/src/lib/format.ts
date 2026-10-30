import prettyBytes from "pretty-bytes"
import { format as formatDate, getYear } from "date-fns"
import { lookup as mimeLookup } from "mime-types"

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—"
  return prettyBytes(bytes)
}

export function formatTime(mtime: number): string {
  if (!mtime) return "—"
  const date = new Date(mtime)
  const pattern =
    getYear(date) === getYear(new Date()) ? "MMM d, HH:mm" : "MMM d, yyyy, HH:mm"
  return formatDate(date, pattern)
}

export type FileKind = "image" | "video" | "audio" | "archive" | "other"

const ARCHIVE_EXTENSIONS = new Set([
  "zip",
  "rar",
  "7z",
  "tar",
  "gz",
  "bz2",
  "xz",
])

export function fileKind(name: string): FileKind {
  const type = mimeLookup(name) || ""
  if (type.startsWith("image/")) return "image"
  if (type.startsWith("video/")) return "video"
  if (type.startsWith("audio/")) return "audio"
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  if (ARCHIVE_EXTENSIONS.has(ext)) return "archive"
  return "other"
}
