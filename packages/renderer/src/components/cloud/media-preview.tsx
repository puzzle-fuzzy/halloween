import * as React from "react"

import { Button } from "@halloween/ui/button"
import { fileKind } from "@/lib/format"
import { capturePlaybackPosition, createPreviewRefreshGuard, playbackTime } from "@/lib/preview-state"
import type { PlaybackPosition } from "@/lib/preview-state"

interface MediaPreviewProps {
  name: string
  url: string
  refreshUrl: () => Promise<string>
  onUrlChange: (url: string) => void
  onRefreshError: (error: unknown) => void
}

export function MediaPreview({ name, url, refreshUrl, onUrlChange, onRefreshError }: MediaPreviewProps) {
  const [currentUrl, setCurrentUrl] = React.useState(url)
  const [generation, setGeneration] = React.useState(0)
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState("")
  const media = React.useRef<HTMLMediaElement | null>(null)
  const playback = React.useRef<PlaybackPosition>({ time: 0, paused: true })
  const restore = React.useRef<PlaybackPosition | null>(null)
  const inFlight = React.useRef(false)
  const mounted = React.useRef(true)
  const retry = React.useRef(createPreviewRefreshGuard()).current
  const kind = fileKind(name)

  React.useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const refresh = async (automatic: boolean) => {
    if (inFlight.current) return
    if (automatic && !retry.claimAutomatic(Date.now())) return
    if (!automatic) retry.recordManual(Date.now())
    inFlight.current = true
    setRefreshing(true)
    const previous = media.current
      ? capturePlaybackPosition({ currentTime: media.current.error ? playback.current.time : media.current.currentTime, paused: playback.current.paused })
      : null
    try {
      const nextUrl = await refreshUrl()
      if (!mounted.current) return
      restore.current = previous
      setCurrentUrl(nextUrl)
      setGeneration((value) => value + 1)
      setError("")
      onUrlChange(nextUrl)
    } catch (e) {
      if (!mounted.current) return
      setError("The preview could not be refreshed. Check your connection and try again.")
      onRefreshError(e)
    } finally {
      inFlight.current = false
      if (mounted.current) setRefreshing(false)
    }
  }

  const failed = () => {
    setError("The preview could not be loaded. Refresh it to try again.")
    void refresh(true)
  }
  const restorePlayback = () => {
    const element = media.current
    const previous = restore.current
    if (!element || !previous) return
    try {
      element.currentTime = playbackTime(previous, element.duration)
      playback.current = previous
      restore.current = null
      if (previous.paused) element.pause()
      else void element.play().catch(() => {
        if (mounted.current) setError("Press play to continue the preview.")
      })
    } catch {
      // Some formats do not allow seeking until canplay; retry there once available.
    }
  }
  const mediaEvents = {
    onError: failed,
    onLoadedMetadata: restorePlayback,
    onCanPlay: restorePlayback,
    onTimeUpdate: () => {
      if (media.current) playback.current.time = media.current.currentTime
    },
    onSeeking: () => {
      if (media.current) playback.current.time = media.current.currentTime
    },
    onPlay: () => { playback.current.paused = false },
    onPause: () => {
      if (media.current && !media.current.error) playback.current.paused = true
    },
  }

  return <div className="flex min-w-0 flex-col gap-3">
    {kind === "image" ? (
      <img key={generation} src={currentUrl} alt={name} onError={failed} onLoad={() => setError("")} className="max-h-[65vh] w-full object-contain" />
    ) : kind === "video" ? (
      <video key={generation} ref={(element) => { media.current = element }} src={currentUrl} controls {...mediaEvents} className="max-h-[65vh] w-full" />
    ) : (
      <audio key={generation} ref={(element) => { media.current = element }} src={currentUrl} controls {...mediaEvents} className="my-8 w-full" />
    )}
    <div className="flex flex-wrap items-center justify-end gap-3">
      <p aria-live="polite" className="text-muted-foreground flex-1 text-sm">{refreshing ? "Refreshing preview…" : error}</p>
      <Button variant="outline" size="sm" disabled={refreshing} onClick={() => void refresh(false)}>Refresh preview</Button>
    </div>
  </div>
}
