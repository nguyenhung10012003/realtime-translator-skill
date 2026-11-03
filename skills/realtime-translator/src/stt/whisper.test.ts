import { describe, expect, it } from 'vitest'
import { parseWhisperJson, pickModelFile } from './whisper'

describe('parseWhisperJson', () => {
  it('reads segments in milliseconds and the detected language', () => {
    const json = JSON.stringify({
      result: { language: 'en' },
      transcription: [
        { offsets: { from: 0, to: 2_500 }, text: ' Hello everyone.' },
        { offsets: { from: 2_500, to: 4_000 }, text: ' Thank you.' },
      ],
    })
    expect(parseWhisperJson(json)).toEqual({
      language: 'en',
      segments: [
        { startMs: 0, endMs: 2_500, text: 'Hello everyone.' },
        { startMs: 2_500, endMs: 4_000, text: 'Thank you.' },
      ],
    })
  })

  it('drops non-speech markers and blank text', () => {
    const json = JSON.stringify({
      transcription: [
        { offsets: { from: 0, to: 1 }, text: ' [BLANK_AUDIO]' },
        { offsets: { from: 1, to: 2 }, text: ' (music)' },
        { offsets: { from: 2, to: 3 }, text: ' ♪ la la ♪' },
        { offsets: { from: 3, to: 4 }, text: '   ' },
        { offsets: { from: 4, to: 5 }, text: ' Real words (with an aside).' },
      ],
    })
    expect(parseWhisperJson(json).segments.map((s) => s.text)).toEqual([
      'Real words (with an aside).',
    ])
  })

  it('tolerates an empty result', () => {
    expect(parseWhisperJson('{}')).toEqual({ language: null, segments: [] })
  })
})

describe('pickModelFile', () => {
  it('prefers small, then base, ignoring other files', () => {
    expect(pickModelFile(['ggml-tiny.bin', 'ggml-base.bin', 'ggml-small.bin'])).toBe(
      'ggml-small.bin',
    )
    expect(pickModelFile(['notes.txt', 'ggml-tiny.bin', 'ggml-base.en.bin'])).toBe(
      'ggml-base.en.bin',
    )
    expect(pickModelFile(['notes.txt'])).toBeNull()
  })
})
