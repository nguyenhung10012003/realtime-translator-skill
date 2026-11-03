import { describe, expect, it } from 'vitest'
import { CaptionPairer } from './captions'

describe('CaptionPairer', () => {
  it('closes a line at the end of a translated sentence', () => {
    const pairer = new CaptionPairer()
    pairer.addSource('Hello ', 100)
    pairer.addSource('everyone.', 400)
    expect(pairer.addTranslation('Xin chào ', 900)).toBeNull()
    expect(pairer.addTranslation('mọi người.', 1_200)).toEqual({
      startMs: 100,
      endMs: 1_200,
      source: 'Hello everyone.',
      translation: 'Xin chào mọi người.',
    })
  })

  it('does not treat a very short fragment as a finished sentence', () => {
    const pairer = new CaptionPairer()
    expect(pairer.addTranslation('Dạ.', 100)).toBeNull()
  })

  it('closes long text even with no punctuation', () => {
    const pairer = new CaptionPairer()
    expect(pairer.addTranslation('một từ '.repeat(20), 100)?.translation).toContain('một từ')
  })

  it('closes a line that has been open too long', () => {
    const pairer = new CaptionPairer()
    expect(pairer.addTranslation('đang nói', 0)).toBeNull()
    expect(pairer.addTranslation(' tiếp', 7_000)?.endMs).toBe(7_000)
  })

  it('starts the next line clean', () => {
    const pairer = new CaptionPairer()
    pairer.addSource('First sentence.', 0)
    pairer.addTranslation('Câu đầu tiên đây.', 500)
    pairer.addSource('Second.', 1_000)
    const next = pairer.addTranslation('Câu thứ hai đây.', 1_500)
    expect(next).toMatchObject({ startMs: 1_000, source: 'Second.' })
  })

  it('falls back to the translation when no source text arrived', () => {
    const pairer = new CaptionPairer()
    expect(pairer.addTranslation('Không có nguồn đây.', 0)?.source).toBe('Không có nguồn đây.')
  })

  it('flushes on finish, dropping source with no translation', () => {
    const pairer = new CaptionPairer()
    pairer.addSource('Unfinished', 0)
    expect(pairer.finish(100)).toBeNull()
    pairer.addTranslation('chưa xong', 200)
    expect(pairer.finish(900)).toMatchObject({ translation: 'chưa xong', endMs: 900 })
  })
})
