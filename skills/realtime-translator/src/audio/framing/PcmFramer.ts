// Re-chunks a push-driven stream of 16 kHz mono Int16 samples (arriving in
// arbitrary sizes from a capture backend) into exact frames. Pure and OS-independent, so it's unit-testable.

import type { AudioFrame } from '../../types'
import { FRAME_SAMPLES, SAMPLE_RATE } from '../constants'

export class PcmFramer {
  private readonly buffer = new Int16Array(FRAME_SAMPLES)
  /** Samples currently held in `buffer`, awaiting a full frame. */
  private filled = 0
  /** Total samples emitted so far — drives the per-frame timestamp. */
  private emittedSamples = 0

  constructor(private readonly onFrame: (frame: AudioFrame) => void) {}

  /** Accumulate samples, emitting a frame each time a full frame is reached. */
  push(samples: Int16Array): void {
    let offset = 0
    while (offset < samples.length) {
      const take = Math.min(FRAME_SAMPLES - this.filled, samples.length - offset)
      this.buffer.set(samples.subarray(offset, offset + take), this.filled)
      this.filled += take
      offset += take
      if (this.filled === FRAME_SAMPLES) this.emit(FRAME_SAMPLES)
    }
  }

  /** Emit any buffered tail (a shorter final frame). Call when capture stops. */
  flush(): void {
    if (this.filled > 0) this.emit(this.filled)
  }

  private emit(count: number): void {
    const pcm = this.buffer.slice(0, count)
    this.onFrame({ pcm, timestampMs: (this.emittedSamples / SAMPLE_RATE) * 1000 })
    this.emittedSamples += count
    this.filled = 0
  }
}
