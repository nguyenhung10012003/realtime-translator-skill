import { describe, expect, it } from 'vitest'
import { rmsLevel, Segmenter, type Utterance } from './segmenter'

const FRAME_SAMPLES = 320 // 20 ms at 16 kHz

function feed(segmenter: Segmenter, pattern: Array<[level: number, ms: number]>): void {
  let t = 0
  for (const [level, ms] of pattern) {
    for (let elapsed = 0; elapsed < ms; elapsed += 20) {
      segmenter.push({ pcm: new Int16Array(FRAME_SAMPLES).fill(level), timestampMs: t })
      t += 20
    }
  }
}

const LOUD = 8_000

describe('rmsLevel', () => {
  it('measures level and handles empty input', () => {
    expect(rmsLevel(new Int16Array(0))).toBe(0)
    expect(rmsLevel(new Int16Array(4).fill(16_384))).toBeCloseTo(0.5)
  })
})

describe('Segmenter', () => {
  const run = (pattern: Array<[number, number]>, flush = true): Utterance[] => {
    const out: Utterance[] = []
    const segmenter = new Segmenter((u) => out.push(u))
    feed(segmenter, pattern)
    if (flush) segmenter.flush()
    return out
  }

  it('emits nothing for silence', () => {
    expect(run([[0, 2_000]])).toEqual([])
  })

  it('cuts one utterance at a silence, with pre-roll and timing from the stream', () => {
    const [utterance, ...rest] = run([
      [0, 1_000],
      [LOUD, 1_000],
      [0, 1_000],
    ])
    expect(rest).toEqual([])
    expect(utterance.startMs).toBe(800) // 200 ms pre-roll before speech at 1000
    expect(utterance.endMs).toBe(2_500) // closed after 500 ms of silence
  })

  it('splits two utterances separated by silence', () => {
    const out = run([
      [LOUD, 500],
      [0, 700],
      [LOUD, 500],
    ])
    expect(out).toHaveLength(2)
  })

  it('discards bursts too short to be speech', () => {
    expect(
      run([
        [LOUD, 100],
        [0, 1_000],
      ]),
    ).toEqual([])
  })

  it('cuts continuous speech at the maximum length, bounding latency', () => {
    const out = run([[LOUD, 13_000]])
    expect(out.length).toBeGreaterThanOrEqual(3)
    for (const u of out) expect(u.endMs - u.startMs).toBeLessThanOrEqual(6_000)
  })

  it('keeps open speech until flush', () => {
    expect(run([[LOUD, 1_000]], false)).toEqual([])
    expect(run([[LOUD, 1_000]], true)).toHaveLength(1)
  })
})
