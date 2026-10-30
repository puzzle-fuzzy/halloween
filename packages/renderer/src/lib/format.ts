export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

export function formatTime(mtime: number): string {
  if (!mtime) return "—"
  const d = new Date(mtime)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  const date = d.toLocaleDateString("zh-CN", {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "2-digit",
    day: "2-digit",
  })
  const time = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
  return `${date} ${time}`
}

export type FileKind = "image" | "video" | "audio" | "archive" | "other"

export function fileKind(name: string): FileKind {
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "avif"].includes(ext)) return "image"
  if (["mp4", "webm", "mkv", "mov", "avi"].includes(ext)) return "video"
  if (["mp3", "flac", "wav", "ogg", "m4a", "aac"].includes(ext)) return "audio"
  if (["zip", "rar", "7z", "tar", "gz", "bz2", "xz"].includes(ext)) return "archive"
  return "other"
}
