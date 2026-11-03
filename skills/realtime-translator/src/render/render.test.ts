import { describe, expect, it } from 'vitest'
import { buildDub, fitTempo, MAX_TEMPO } from './render'

const SAMPLES_PER_MS = 24

/** Fake synthesis: text like "500" yields 500 ms of samples valued by first digit. */
const synth = async (text: string): Promise<Int16Array> =>
  new Int16Array(Number(text) * SAMPLES_PER_MS).fill(Number(text[0]))

/** Fake speed-up: shortens by the tempo, as atempo does. */
const speedUp = async (pcm: Int16Array, tempo: number): Promise<Int16Array> =>
  pcm.slice(0, Math.round(pcm.length / tempo))

describe('fitTempo', () => {
  it('leaves speech that fits alone', () => {
    expect(fitTempo(1_000, 2_000)).toBe(1)
  })

  it('speeds up just enough, within the limit', () => {
    expect(fitTempo(1_200, 1_000)).toBeCloseTo(1.2)
    expect(fitTempo(5_000, 1_000)).toBe(MAX_TEMPO)
  })

  it('does nothing when there is no room to fit into', () => {
    expect(fitTempo(1_000, 0)).toBe(1)
    expect(fitTempo(1_000, -50)).toBe(1)
  })
})

describe('buildDub', () => {
  it('places each line at its source time, with silence between', async () => {
    const pcm = await buildDub(
      [
        { text: '100', startMs: 1_000, nextStartMs: 2_000 },
        { text: '200', startMs: 2_000, nextStartMs: null },
      ],
      synth,
      speedUp,
    )
    expect(pcm.length).toBe(2_200 * SAMPLES_PER_MS)
    expect(pcm[0]).toBe(0)
    expect(pcm[1_000 * SAMPLES_PER_MS]).toBe(1)
    expect(pcm[1_500 * SAMPLES_PER_MS]).toBe(0)
    expect(pcm[2_000 * SAMPLES_PER_MS]).toBe(2)
  })

  it('speeds up a line that overruns its slot', async () => {
    const pcm = await buildDub(
      [
        { text: '600', startMs: 0, nextStartMs: 500 },
        { text: '100', startMs: 500, nextStartMs: null },
      ],
      synth,
      speedUp,
    )
    expect(pcm.length).toBe(600 * SAMPLES_PER_MS)
    expect(pcm[500 * SAMPLES_PER_MS]).toBe(1)
  })

  it('delays the next line instead of overlapping when speed-up is not enough', async () => {
    const pcm = await buildDub(
      [
        { text: '900', startMs: 0, nextStartMs: 300 }, // needs 3x, capped at 1.5x → 600 ms
        { text: '100', startMs: 300, nextStartMs: null },
      ],
      synth,
      speedUp,
    )
    expect(pcm[599 * SAMPLES_PER_MS]).toBe(9)
    expect(pcm[600 * SAMPLES_PER_MS]).toBe(1) // waited for the first line to end
    expect(pcm.length).toBe(700 * SAMPLES_PER_MS)
  })

  it('returns empty audio for no lines', async () => {
    expect((await buildDub([], synth, speedUp)).length).toBe(0)
  })
})
