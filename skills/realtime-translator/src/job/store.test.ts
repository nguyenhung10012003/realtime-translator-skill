import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JobStore } from './store'

describe('JobStore', () => {
  let dir: string
  let job: JobStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rtt-store-'))
    job = new JobStore(join(dir, 'job'))
    job.create({ mode: 'file', source: 'a.mp3', targetLanguage: 'vi', sourceLanguage: null })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const add = (id: number, text: string): void => {
    job.addSegment({ startMs: id * 1000, endMs: id * 1000 + 500, text }, id)
  }

  it('tracks pending segments until they are translated', () => {
    add(1, 'one')
    add(2, 'two')
    expect(job.pending().map((s) => s.id)).toEqual([1, 2])
    expect(job.pending(1).map((s) => s.id)).toEqual([1])
    job.addTranslations([{ id: 1, text: 'một' }])
    expect(job.pending().map((s) => s.id)).toEqual([2])
  })

  it('lets a later translation correct an earlier one', () => {
    add(1, 'one')
    job.addTranslations([{ id: 1, text: 'first try' }])
    job.addTranslations([{ id: 1, text: 'một' }])
    expect(job.translations().get(1)).toBe('một')
  })

  it('rejects unknown ids and blank text, writing nothing from that batch', () => {
    add(1, 'one')
    expect(() =>
      job.addTranslations([
        { id: 1, text: 'một' },
        { id: 9, text: 'x' },
      ]),
    ).toThrow(/Unknown segment id: 9/)
    expect(() => job.addTranslations([{ id: 1, text: '  ' }])).toThrow(/Empty translation/)
    expect(job.translations().size).toBe(0)
  })

  it('ignores a line caught mid-append', () => {
    add(1, 'one')
    appendFileSync(join(job.dir, 'segments.jsonl'), '{"id":2,"sta')
    expect(job.segments().map((s) => s.id)).toEqual([1])
  })

  it('create() starts a re-used directory clean', () => {
    add(1, 'one')
    job.addTranslations([{ id: 1, text: 'một' }])
    job.create({ mode: 'file', source: 'b.mp3', targetLanguage: 'ja', sourceLanguage: null })
    expect(job.segments()).toEqual([])
    expect(job.translations().size).toBe(0)
    expect(job.info()).toMatchObject({ source: 'b.mp3', targetLanguage: 'ja', finished: false })
  })
})
