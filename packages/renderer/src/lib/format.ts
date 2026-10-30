import prettyBytes from "pretty-bytes"
import { format as formatDate, getYear } from "date-fns"

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

// extension map instead of mime-types: that lib needs node:path, which does not
// exist in a browser bundle and crashes the renderer (extname is not a function)
const KIND_BY_EXTENSION: Record<string, FileKind> = {
  jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image",
  svg: "image", bmp: "image", avif: "image", ico: "image",
  mp4: "video", webm: "video", mkv: "video", mov: "video", avi: "video", m4v: "video",
  mp3: "audio", flac: "audio", wav: "audio", ogg: "audio", m4a: "audio", aac: "audio",
  zip: "archive", rar: "archive", "7z": "archive", tar: "archive", gz: "archive",
  bz2: "archive", xz: "archive",
}

export function fileKind(name: string): FileKind {
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  return KIND_BY_EXTENSION[ext] ?? "other"
}

