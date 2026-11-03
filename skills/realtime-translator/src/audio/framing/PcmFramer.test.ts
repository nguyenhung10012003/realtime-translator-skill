import { describe, expect, it } from 'vitest'
import type { AudioFrame } from '../../types'
import { PcmFramer } from './PcmFramer'
import { FRAME_MS, FRAME_SAMPLES } from '../constants'

function collect(): { frames: AudioFrame[]; framer: PcmFramer } {
  const frames: AudioFrame[] = []
  const framer = new PcmFramer((f) => frames.push(f))
  return { frames, framer }
}

describe('PcmFramer', () => {
  it('emits exact FRAME_SAMPLES frames regardless of push size', () => {
    const { frames, framer } = collect()
    const remainder = Math.floor(FRAME_SAMPLES / 4) // a partial, sub-frame tail
    const total = FRAME_SAMPLES * 2 + remainder
    const chunkSizes = [7, 1000, 333, FRAME_SAMPLES, 999]
    let pushed = 0
    let i = 0
    while (pushed < total) {
      const size = Math.min(chunkSizes[i % chunkSizes.length], total - pushed)
      framer.push(new Int16Array(size).fill(i + 1))
      pushed += size
      i++
    }
    expect(frames.length).toBe(2) // 2 full frames; the remainder still buffered
    expect(frames.every((f) => f.pcm.length === FRAME_SAMPLES)).toBe(true)
  })

  it('assigns monotonic per-frame timestamps', () => {
    const { frames, framer } = collect()
    framer.push(new Int16Array(FRAME_SAMPLES * 3))
    expect(frames.map((f) => f.timestampMs)).toEqual([0, FRAME_MS, FRAME_MS * 2])
  })

  it('flush emits the buffered tail as a shorter frame', () => {
    const { frames, framer } = collect()
    framer.push(new Int16Array(FRAME_SAMPLES + 250))
    expect(frames.length).toBe(1)
    framer.flush()
    expect(frames.length).toBe(2)
    expect(frames[1].pcm.length).toBe(250)
    expect(frames[1].timestampMs).toBe(FRAME_MS)
  })

  it('flush with an empty buffer emits nothing', () => {
    const { frames, framer } = collect()
    framer.push(new Int16Array(FRAME_SAMPLES)) // exactly one frame; buffer drains
    framer.flush()
    expect(frames.length).toBe(1)
  })

  it('preserves sample values across frame boundaries', () => {
    const { frames, framer } = collect()
    const data = new Int16Array(FRAME_SAMPLES + 10)
    for (let i = 0; i < data.length; i++) data[i] = (i % 100) - 50
    framer.push(data)
    framer.flush()
    const out = new Int16Array(FRAME_SAMPLES + 10)
    out.set(frames[0].pcm, 0)
    out.set(frames[1].pcm, FRAME_SAMPLES)
    expect(Array.from(out)).toEqual(Array.from(data))
  })
})
