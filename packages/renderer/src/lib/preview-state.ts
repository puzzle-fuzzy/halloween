export interface PlaybackPosition {
  time: number
  paused: boolean
}

/** A broken image or unsupported codec must not cause an endless refresh loop. */
export function createPreviewRefreshGuard(intervalMs = 60_000) {
  let lastRefresh = Number.NEGATIVE_INFINITY
  return {
    claimAutomatic(now: number): boolean {
      if (now - lastRefresh < intervalMs) return false
      lastRefresh = now
      return true
    },
    recordManual(now: number) { lastRefresh = now },
  }
}

export function capturePlaybackPosition(media: { currentTime: number; paused: boolean }): PlaybackPosition {
  return { time: Number.isFinite(media.currentTime) ? Math.max(0, media.currentTime) : 0, paused: media.paused }
}

export function playbackTime(position: PlaybackPosition, duration: number): number {
  return Number.isFinite(duration) ? Math.min(position.time, Math.max(0, duration - 0.05)) : position.time
}
