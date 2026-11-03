import type { AudioFrame } from '../types'
import { SAMPLE_RATE } from './constants'

/** One stretch of speech, ready for transcription. */
export interface Utterance {
  pcm: Int16Array
  startMs: number
  endMs: number
}

export interface SegmenterOptions {
  /** RMS level (0..1) above which a frame counts as speech. */
  thresholdRms?: number
  /** Silence this long closes the utterance. */
  silenceMs?: number
  /** Shorter bursts are noise and get discarded. */
  minSpeechMs?: number
  /** Cut here even mid-sentence, which bounds latency during continuous speech. */
  maxUtteranceMs?: number
  /** Audio kept from before speech starts, so first syllables aren't clipped. */
  preRollMs?: number
}

const DEFAULTS: Required<SegmenterOptions> = {
  thresholdRms: 0.01,
  silenceMs: 500,
  minSpeechMs: 300,
  maxUtteranceMs: 6_000,
  preRollMs: 200,
}

/** RMS level of 16-bit PCM, in 0..1. */
export function rmsLevel(pcm: Int16Array): number {
  if (pcm.length === 0) return 0
  let sum = 0
  for (const sample of pcm) sum += sample * sample
  return Math.sqrt(sum / pcm.length) / 32768
}

/**
 * Energy-based voice activity detection: cuts a continuous frame stream into
 * utterances, because a batch recognizer needs bounded chunks. Pure, so it runs
 * the same on every capture backend and is testable without audio hardware.
 */
export class Segmenter {
  private readonly options: Required<SegmenterOptions>
  private preRoll: AudioFrame[] = []
  private frames: AudioFrame[] = []
  private speechMs = 0
  private silentMs = 0

  constructor(
    private readonly onUtterance: (utterance: Utterance) => void,
    options: SegmenterOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options }
  }

  push(frame: AudioFrame): void {
    const frameMs = (frame.pcm.length / SAMPLE_RATE) * 1000
    const voiced = rmsLevel(frame.pcm) >= this.options.thresholdRms

    if (this.frames.length === 0) {
      if (!voiced) {
        this.remember(frame, frameMs)
        return
      }
      this.frames = this.preRoll
      this.preRoll = []
    }

    this.frames.push(frame)
    if (voiced) {
      this.speechMs += frameMs
      this.silentMs = 0
    } else {
      this.silentMs += frameMs
    }

    const spanMs = this.endOf(frame) - this.frames[0].timestampMs
    if (this.silentMs >= this.options.silenceMs || spanMs >= this.options.maxUtteranceMs) {
      this.close()
    }
  }

  /** Emits whatever is open. Call when the source ends. */
  flush(): void {
    if (this.frames.length > 0) this.close()
  }

  private remember(frame: AudioFrame, frameMs: number): void {
    this.preRoll.push(frame)
    const keep = Math.max(1, Math.round(this.options.preRollMs / frameMs))
    if (this.preRoll.length > keep) this.preRoll.shift()
  }

  private endOf(frame: AudioFrame): number {
    return frame.timestampMs + (frame.pcm.length / SAMPLE_RATE) * 1000
  }

  private close(): void {
    const frames = this.frames
    const speechMs = this.speechMs
    this.frames = []
    this.speechMs = 0
    this.silentMs = 0
    if (speechMs < this.options.minSpeechMs) return

    const total = frames.reduce((sum, frame) => sum + frame.pcm.length, 0)
    const pcm = new Int16Array(total)
    let offset = 0
    for (const frame of frames) {
      pcm.set(frame.pcm, offset)
      offset += frame.pcm.length
    }
    this.onUtterance({
      pcm,
      startMs: frames[0].timestampMs,
      endMs: this.endOf(frames[frames.length - 1]),
    })
  }
}
