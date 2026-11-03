// Pure PCM conversion + resampling. No native or platform dependencies, so this
// is fully unit-testable on any OS and reused by every live capture backend.
// Turns raw interleaved capture PCM (any rate/channel count) into the 16 kHz
// mono Int16 stream the recognizer expects.

import { SAMPLE_RATE } from '../constants'

/** Sample format of the raw bytes a capture backend hands us. */
export type RawPcmFormat = 'f32' | 's16'

/** Int16 PCM → float in [-1, 1). */
export function int16ToFloat32(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length)
  for (let i = 0; i < input.length; i++) out[i] = input[i] / 0x8000
  return out
}

/** Float → Int16 PCM, clamped to [-1, 1] so overshoot can't wrap around. */
export function float32ToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = input[i] < -1 ? -1 : input[i] > 1 ? 1 : input[i]
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

/** Average interleaved channels down to a single mono track. */
export function downmixToMono(interleaved: Float32Array, channels: number): Float32Array {
  if (channels <= 1) return interleaved
  const frames = Math.floor(interleaved.length / channels)
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    const base = i * channels
    for (let c = 0; c < channels; c++) sum += interleaved[base + c]
    out[i] = sum / channels
  }
  return out
}

/**
 * Resample a mono float track from `inRate` to `outRate`. Integer downsampling
 * (e.g. 48k→16k = 3:1) averages each group of samples — a cheap box-filter that
 * curbs aliasing; any other ratio (e.g. 44.1k→16k) uses linear interpolation.
 */
export function resampleMono(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate || input.length === 0) return input

  if (inRate > outRate && inRate % outRate === 0) {
    const factor = inRate / outRate
    const outLength = Math.floor(input.length / factor)
    const out = new Float32Array(outLength)
    for (let i = 0; i < outLength; i++) {
      let sum = 0
      const base = i * factor
      for (let j = 0; j < factor; j++) sum += input[base + j]
      out[i] = sum / factor
    }
    return out
  }

  const ratio = inRate / outRate
  const outLength = Math.max(1, Math.round(input.length / ratio))
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = pos - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}

export interface PcmResamplerOptions {
  /** Capture sample rate. WASAPI shared-mode mix is usually 48000. */
  inputSampleRate?: number
  /** Interleaved channel count of the capture (typically 2). */
  inputChannels?: number
  /** Sample format of the raw bytes. WASAPI loopback is usually 32-bit float. */
  format?: RawPcmFormat
  /** Output rate; defaults to the pipeline rate (16 kHz). */
  outputSampleRate?: number
}

/**
 * Streaming wrapper around the pure helpers above: feed it raw interleaved PCM
 * chunks (as they arrive from a capture backend) and it returns 16 kHz mono
 * Int16. Carries bytes that don't complete an interleaved sample-frame across
 * `process()` calls, so a sample split across two chunks is never corrupted.
 */
export class PcmResampler {
  private readonly inRate: number
  private readonly channels: number
  private readonly format: RawPcmFormat
  private readonly outRate: number
  private readonly bytesPerSample: number
  /** Bytes for one interleaved sample-frame across all channels. */
  private readonly frameBytes: number
  /**
   * Integer downsample ratio (e.g. 48k→16k = 3) or 0 when not an exact
   * integer. When set, each `process()` consumes only a whole multiple of this
   * many input frames so the box-filter in {@link resampleMono} never discards
   * a partial group — the remainder rides along in `leftover` to the next call.
   */
  private readonly decimation: number
  private leftover = Buffer.alloc(0)

  constructor(options: PcmResamplerOptions = {}) {
    this.inRate = options.inputSampleRate ?? 48_000
    this.channels = options.inputChannels ?? 2
    this.format = options.format ?? 'f32'
    this.outRate = options.outputSampleRate ?? SAMPLE_RATE
    this.bytesPerSample = this.format === 'f32' ? 4 : 2
    this.frameBytes = this.bytesPerSample * this.channels
    this.decimation =
      this.inRate > this.outRate && this.inRate % this.outRate === 0
        ? this.inRate / this.outRate
        : 0
  }

  /** Convert one chunk of raw interleaved capture PCM to 16 kHz mono Int16. */
  process(bytes: Uint8Array): Int16Array {
    const incoming = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const buf = this.leftover.length ? Buffer.concat([this.leftover, incoming]) : incoming

    let completeFrames = Math.floor(buf.length / this.frameBytes)
    // Keep the frame count a whole multiple of the decimation factor so the
    // box-filter consumes every sample; the leftover frames carry to next call.
    if (this.decimation > 0) completeFrames -= completeFrames % this.decimation
    const usableBytes = completeFrames * this.frameBytes
    this.leftover = Buffer.from(buf.subarray(usableBytes))
    if (completeFrames === 0) return new Int16Array(0)

    const sampleCount = completeFrames * this.channels
    const interleaved = new Float32Array(sampleCount)
    if (this.format === 'f32') {
      for (let i = 0; i < sampleCount; i++) interleaved[i] = buf.readFloatLE(i * 4)
    } else {
      for (let i = 0; i < sampleCount; i++) interleaved[i] = buf.readInt16LE(i * 2) / 0x8000
    }

    const mono = downmixToMono(interleaved, this.channels)
    const resampled = resampleMono(mono, this.inRate, this.outRate)
    return float32ToInt16(resampled)
  }

  /** Drop any buffered partial frame — call when capture stops. */
  reset(): void {
    this.leftover = Buffer.alloc(0)
  }
}
