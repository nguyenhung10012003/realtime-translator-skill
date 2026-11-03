import { describe, expect, it } from 'vitest'
import { parseProcessList, parseTapHeader, tapExitMessage } from './tapHelper'

describe('parseTapHeader', () => {
  it('parses a valid header line', () => {
    expect(parseTapHeader('AUDIO-TAP 1 rate=48000 channels=1 format=f32')).toEqual({
      sampleRate: 48_000,
      channels: 1,
      format: 'f32',
    })
    expect(parseTapHeader('AUDIO-TAP 1 rate=44100 channels=2 format=s16\n')).toEqual({
      sampleRate: 44_100,
      channels: 2,
      format: 's16',
    })
  })

  it('rejects malformed or out-of-range headers', () => {
    expect(parseTapHeader('')).toBeNull()
    expect(parseTapHeader('AUDIO-TAP 2 rate=48000 channels=1 format=f32')).toBeNull()
    expect(parseTapHeader('AUDIO-TAP 1 rate=48000 channels=1 format=f64')).toBeNull()
    expect(parseTapHeader('AUDIO-TAP 1 rate=999999 channels=1 format=f32')).toBeNull()
    expect(parseTapHeader('AUDIO-TAP 1 rate=48000 channels=0 format=f32')).toBeNull()
    expect(parseTapHeader('garbage before AUDIO-TAP 1 rate=48000 channels=1 format=f32')).toBeNull()
  })
})

describe('tapExitMessage', () => {
  it('maps the documented exit codes to actionable messages', () => {
    expect(tapExitMessage(69, '')).toMatch(/14\.4/)
    expect(tapExitMessage(66, '')).toMatch(/no longer/)
    expect(tapExitMessage(77, '')).toMatch(/System Audio Recording/)
  })

  it('falls back to the last stderr line for unknown codes', () => {
    expect(tapExitMessage(70, 'a\nAudioDeviceStart failed (OSStatus -50)\n')).toMatch(
      /OSStatus -50/,
    )
    expect(tapExitMessage(null, '')).toMatch(/unknown/)
  })
})

describe('parseProcessList', () => {
  const sample = JSON.stringify([
    {
      pid: 5805,
      name: 'Microsoft Edge Helper',
      bundleId: 'com.microsoft.edgemac.helper',
      audioActive: true,
      system: false,
    },
    {
      pid: 964,
      name: 'audioaccessoryd',
      bundleId: 'com.apple.cloudpaird',
      audioActive: false,
      system: true,
    },
    {
      pid: 700,
      name: 'WebKit GPU',
      bundleId: 'com.apple.WebKit.GPU',
      audioActive: true,
      system: true,
    },
    { pid: 123, name: 'Music', bundleId: 'com.apple.Music', audioActive: false, system: false },
  ])

  it('keeps apps and playing processes, drops idle system daemons', () => {
    expect(parseProcessList(sample)).toEqual([
      { id: '5805', name: '🔊 Microsoft Edge Helper' },
      { id: '700', name: '🔊 WebKit GPU' },
      { id: '123', name: 'Music' },
    ])
  })

  it('is defensive about malformed input', () => {
    expect(parseProcessList('not json')).toEqual([])
    expect(parseProcessList('{"pid":1}')).toEqual([])
    expect(parseProcessList('[{"pid":"x","name":3},{"pid":9,"name":"ok"}]')).toEqual([
      { id: '9', name: 'ok' },
    ])
  })
})
