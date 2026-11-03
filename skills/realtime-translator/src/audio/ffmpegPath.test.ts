import { describe, expect, it } from 'vitest'
import { describeSpawnError, resolveToolPath } from './ffmpegPath'

describe('resolveToolPath', () => {
  it('prefers an explicit override', () => {
    expect(resolveToolPath('ffmpeg', '/opt/ffmpeg')).toBe('/opt/ffmpeg')
  })

  it('falls back to PATH, ignoring a blank override', () => {
    expect(resolveToolPath('ffmpeg', '   ')).toBe('ffmpeg')
    expect(resolveToolPath('ffmpeg')).toBe('ffmpeg')
  })
})

describe('describeSpawnError', () => {
  it('explains a missing binary', () => {
    const enoent = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' })
    expect(describeSpawnError('ffmpeg', 'ffmpeg', enoent).message).toMatch(/setup\.mjs/)
  })

  it('passes other errors through', () => {
    const denied = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })
    expect(describeSpawnError('ffmpeg', 'ffmpeg', denied)).toBe(denied)
  })
})
