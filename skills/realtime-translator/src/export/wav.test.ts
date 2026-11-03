import { describe, expect, it } from 'vitest'
import { concatInt16, pcm16ToWav } from './wav'

describe('concatInt16', () => {
  it('joins chunks in order', () => {
    const joined = concatInt16([new Int16Array([1, 2]), new Int16Array([]), new Int16Array([3])])
    expect(Array.from(joined)).toEqual([1, 2, 3])
  })
})

describe('pcm16ToWav', () => {
  it('writes a valid 44-byte RIFF header for 24 kHz mono', () => {
    const wav = pcm16ToWav(new Int16Array([0, 1, -1, 32767]), 24_000)
    expect(wav.length).toBe(44 + 8)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(4)).toBe(36 + 8) // RIFF chunk size
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt16LE(20)).toBe(1) // PCM
    expect(wav.readUInt16LE(22)).toBe(1) // mono
    expect(wav.readUInt32LE(24)).toBe(24_000)
    expect(wav.readUInt32LE(28)).toBe(48_000) // byte rate
    expect(wav.readUInt16LE(34)).toBe(16) // bits per sample
    expect(wav.readUInt32LE(40)).toBe(8) // data bytes
    expect(wav.readInt16LE(44 + 2)).toBe(1)
    expect(wav.readInt16LE(44 + 4)).toBe(-1)
  })

  it('round-trips samples from an offset Int16Array view', () => {
    const backing = new Int16Array([9, 9, 5, 6, 7])
    const view = backing.subarray(2)
    const wav = pcm16ToWav(view, 16_000)
    expect([wav.readInt16LE(44), wav.readInt16LE(46), wav.readInt16LE(48)]).toEqual([5, 6, 7])
  })
})
