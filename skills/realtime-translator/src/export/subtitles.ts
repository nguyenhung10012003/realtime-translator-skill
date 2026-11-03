// SRT and WebVTT serialization.

/** One subtitle cue on a monotonic, non-overlapping timeline. */
export interface SubtitleCue {
  startMs: number
  endMs: number
  text: string
}

/** ms → `HH:MM:SS<separator>mmm`, zero-padded, clamped at 0. */
function formatTime(ms: number, separator: string): string {
  const total = Math.max(0, Math.floor(ms))
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor((total % 3_600_000) / 60_000)
  const seconds = Math.floor((total % 60_000) / 1000)
  const millis = total % 1000
  const pad = (value: number, width: number): string => String(value).padStart(width, '0')
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${separator}${pad(millis, 3)}`
}

/** Serializes cues as SubRip (.srt). */
export function formatSrt(cues: readonly SubtitleCue[]): string {
  return cues
    .map(
      (cue, index) =>
        `${index + 1}\n${formatTime(cue.startMs, ',')} --> ${formatTime(cue.endMs, ',')}\n${cue.text}\n`,
    )
    .join('\n')
}

/** Serializes cues as WebVTT (.vtt). */
export function formatVtt(cues: readonly SubtitleCue[]): string {
  const body = cues
    .map(
      (cue) => `${formatTime(cue.startMs, '.')} --> ${formatTime(cue.endMs, '.')}\n${cue.text}\n`,
    )
    .join('\n')
  return `WEBVTT\n\n${body}`
}
