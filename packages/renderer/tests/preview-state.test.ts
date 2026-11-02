import { describe, expect, test } from "bun:test"
import { capturePlaybackPosition, createPreviewRefreshGuard, playbackTime } from "../src/lib/preview-state"

describe("preview recovery", () => {
  test("a codec failure cannot continually fetch new preview URLs", () => {
    const guard = createPreviewRefreshGuard()
    expect(guard.claimAutomatic(100_000)).toBe(true)
    expect(guard.claimAutomatic(100_001)).toBe(false)
    expect(guard.claimAutomatic(159_999)).toBe(false)
    expect(guard.claimAutomatic(160_000)).toBe(true)
    guard.recordManual(170_000)
    expect(guard.claimAutomatic(170_001)).toBe(false)
  })

  test("refresh preserves the seek position and previous playing or paused state", () => {
    const playing = capturePlaybackPosition({ currentTime: 372.5, paused: false })
    expect(playbackTime(playing, 1800)).toBe(372.5)
    expect(playing.paused).toBe(false)
    const paused = capturePlaybackPosition({ currentTime: 619, paused: true })
    expect(playbackTime(paused, Number.POSITIVE_INFINITY)).toBe(619)
    expect(paused.paused).toBe(true)
  })

  test("a changed media duration cannot restore beyond the end", () => {
    const position = capturePlaybackPosition({ currentTime: 600, paused: false })
    expect(playbackTime(position, 300)).toBe(299.95)
    expect(capturePlaybackPosition({ currentTime: Number.NaN, paused: true }).time).toBe(0)
  })
})
