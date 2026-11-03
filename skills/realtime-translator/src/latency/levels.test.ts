import { describe, expect, it } from 'vitest'
import { assessLevels, realtimeSupports, SEGMENTATION, type LevelFacts } from './levels'

const facts = (overrides: Partial<LevelFacts> = {}): LevelFacts => ({
  targetLanguage: 'vi',
  localStt: false,
  sttProviders: [],
  translators: [],
  realtimeProviders: [],
  streamingPlayback: true,
  ...overrides,
})

const byLevel = (input: LevelFacts) =>
  Object.fromEntries(assessLevels(input).map((report) => [report.level, report]))

describe('SEGMENTATION', () => {
  it('waits less and cuts sooner as levels get faster', () => {
    const { careful, balanced, fast } = SEGMENTATION
    expect(careful.silenceMs!).toBeGreaterThan(balanced.silenceMs!)
    expect(balanced.silenceMs!).toBeGreaterThan(fast.silenceMs!)
    expect(careful.maxUtteranceMs!).toBeGreaterThan(balanced.maxUtteranceMs!)
    expect(balanced.maxUtteranceMs!).toBeGreaterThan(fast.maxUtteranceMs!)
  })
})

describe('realtimeSupports', () => {
  it('checks OpenAI against its documented targets, by primary language', () => {
    expect(realtimeSupports('openai', 'vi')).toBe(true)
    expect(realtimeSupports('openai', 'zh-Hans')).toBe(true)
    expect(realtimeSupports('openai', 'th')).toBe(false)
  })

  it('leaves Gemini to the service, which documents far more', () => {
    expect(realtimeSupports('gemini', 'th')).toBe(true)
  })
})

describe('assessLevels', () => {
  it('reports nothing available, with reasons, on a bare machine', () => {
    const levels = byLevel(facts())
    expect(Object.values(levels).every((level) => !level.available)).toBe(true)
    expect(levels.careful.missing).toContain('speech recognition')
    expect(levels.realtime.missing).toContain('key')
  })

  it('offers careful with local recognition alone', () => {
    const levels = byLevel(facts({ localStt: true }))
    expect(levels.careful.available).toBe(true)
    expect(levels.balanced.available).toBe(false)
    expect(levels.balanced.missing).toContain('translation provider')
  })

  it('offers chunked levels once a translator exists', () => {
    const levels = byLevel(facts({ localStt: true, translators: ['anthropic'] }))
    expect(levels.balanced.available).toBe(true)
    expect(levels.fast.available).toBe(true)
    expect(levels.fast.providers).toEqual(['anthropic'])
    expect(levels.realtime.available).toBe(false)
  })

  it('filters realtime providers by the target language', () => {
    const blocked = byLevel(facts({ targetLanguage: 'th', realtimeProviders: ['openai'] }))
    expect(blocked.realtime.available).toBe(false)
    expect(blocked.realtime.missing).toContain('"th"')

    const allowed = byLevel(
      facts({ targetLanguage: 'th', realtimeProviders: ['openai', 'gemini'] }),
    )
    expect(allowed.realtime.providers).toEqual(['gemini'])
  })

  it('is honest about which latencies were measured', () => {
    const levels = byLevel(facts())
    expect(levels.balanced.measured).toBe(true)
    expect(levels.careful.measured).toBe(false)
    expect(levels.fast.measured).toBe(false)
    expect(levels.realtime.measured).toBe(false)
  })

  it('notes missing streaming playback without blocking the level', () => {
    const levels = byLevel(facts({ realtimeProviders: ['gemini'], streamingPlayback: false }))
    expect(levels.realtime.available).toBe(true)
    expect(levels.realtime.note).toContain('ffplay')
  })
})
