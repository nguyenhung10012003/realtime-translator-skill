import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import { changeTempo } from '../audio/ffmpegTools'
import { encodeMp3 } from '../export/encodeMp3'
import { formatSrt, formatVtt, type SubtitleCue } from '../export/subtitles'
import { pcm16ToWav } from '../export/wav'
import type { JobStore, Segment } from '../job/store'
import { TTS_SAMPLE_RATE, type Speaker } from '../tts/tts'

/** Faster than this and synthesized speech stops being comfortable to follow. */
export const MAX_TEMPO = 1.5

/** Speed-up needed for speech to fit its slot; 1 when it fits or there's no limit. */
export function fitTempo(speechMs: number, slotMs: number, maxTempo = MAX_TEMPO): number {
  if (slotMs <= 0 || speechMs <= slotMs) return 1
  return Math.min(speechMs / slotMs, maxTempo)
}

export interface Placement {
  text: string
  /** When this speech should start, from the source timeline. */
  startMs: number
  /** Next cue's start, which this speech should finish by if it can. */
  nextStartMs: number | null
}

/**
 * Lays synthesized speech on the source timeline: each line starts at its source
 * time, is sped up (within limits) to end before the next line, and if it still
 * overruns, the next line waits. Lines therefore never overlap.
 */
export async function buildDub(
  placements: Placement[],
  synthesize: (text: string) => Promise<Int16Array>,
  speedUp: (pcm: Int16Array, tempo: number) => Promise<Int16Array>,
  onProgress?: (done: number, total: number) => void,
): Promise<Int16Array> {
  const samplesPerMs = TTS_SAMPLE_RATE / 1000
  const pieces: Array<{ at: number; pcm: Int16Array }> = []
  let cursor = 0

  for (const [index, placement] of placements.entries()) {
    let pcm = await synthesize(placement.text)
    const at = Math.max(Math.round(placement.startMs * samplesPerMs), cursor)
    if (placement.nextStartMs !== null) {
      const slotMs = placement.nextStartMs - at / samplesPerMs
      const tempo = fitTempo(pcm.length / samplesPerMs, slotMs)
      if (tempo > 1.02) pcm = await speedUp(pcm, tempo)
    }
    pieces.push({ at, pcm })
    cursor = at + pcm.length
    onProgress?.(index + 1, placements.length)
  }

  const out = new Int16Array(cursor)
  for (const piece of pieces) out.set(piece.pcm, piece.at)
  return out
}

export type TrackSelection = 'both' | 'source' | 'translated'

export interface RenderOptions {
  srt?: string
  vtt?: string
  audio?: string
  track: TrackSelection
  speaker?: Speaker
  onProgress?: (done: number, total: number) => void
}

export interface WrittenFile {
  kind: 'audio' | 'subtitles'
  format: string
  path: string
  track?: 'source' | 'translated'
}

const write = (path: string, data: string | Buffer): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, data)
}

/** `x.srt` becomes `x.<marker>.srt` when one flag has to produce two files. */
function trackPath(path: string, marker: string): string {
  const ext = extname(path)
  return `${path.slice(0, path.length - ext.length)}.${marker}${ext}`
}

function cuesOf(segments: Segment[], textOf: (segment: Segment) => string): SubtitleCue[] {
  return segments.map((segment) => ({
    startMs: segment.startMs,
    endMs: Math.max(segment.endMs, segment.startMs + 600),
    text: textOf(segment),
  }))
}

/**
 * Writes the requested subtitles and dubbed audio. Both subtitle tracks stay on the
 * source timeline, so they fit the original recording and the dub alike.
 */
export async function render(job: JobStore, options: RenderOptions): Promise<WrittenFile[]> {
  const info = job.info()
  const translations = job.translations()
  const segments = job.segments().filter((segment) => translations.has(segment.id))
  const written: WrittenFile[] = []

  const tracks: Array<'source' | 'translated'> =
    options.track === 'both' ? ['source', 'translated'] : [options.track]
  const formats: Array<['srt' | 'vtt', string | undefined]> = [
    ['srt', options.srt],
    ['vtt', options.vtt],
  ]

  for (const [format, base] of formats) {
    if (!base) continue
    for (const track of tracks) {
      const cues =
        track === 'source'
          ? cuesOf(segments, (segment) => segment.text)
          : cuesOf(segments, (segment) => translations.get(segment.id) as string)
      const marker = track === 'source' ? 'source' : info.targetLanguage
      const path = tracks.length > 1 ? trackPath(base, marker) : base
      write(path, format === 'srt' ? formatSrt(cues) : formatVtt(cues))
      written.push({ kind: 'subtitles', format, track, path })
    }
  }

  if (options.audio) {
    if (!options.speaker) throw new Error('Rendering audio needs a speaker.')
    const speaker = options.speaker
    const placements: Placement[] = segments.map((segment, index) => ({
      text: translations.get(segment.id) as string,
      startMs: segment.startMs,
      nextStartMs: segments[index + 1]?.startMs ?? null,
    }))
    const pcm = await buildDub(
      placements,
      (text) => speaker.synthesize(text),
      (samples, tempo) => changeTempo(samples, TTS_SAMPLE_RATE, tempo),
      options.onProgress,
    )
    const isMp3 = extname(options.audio).toLowerCase() === '.mp3'
    mkdirSync(dirname(options.audio), { recursive: true })
    if (isMp3) await encodeMp3(pcm, TTS_SAMPLE_RATE, options.audio)
    else write(options.audio, pcm16ToWav(pcm, TTS_SAMPLE_RATE))
    written.push({ kind: 'audio', format: isMp3 ? 'mp3' : 'wav', path: options.audio })
  }

  return written
}
