import { describe, expect, it } from 'vitest'
import {
  PcmResampler,
  downmixToMono,
  float32ToInt16,
  int16ToFloat32,
  resampleMono,
} from './resamplePcm'

describe('int16 <-> float32', () => {
  it('maps full-scale endpoints', () => {
    expect(Array.from(float32ToInt16(new Float32Array([0, 1, -1])))).toEqual([0, 32767, -32768])
  })

  it('clamps out-of-range floats', () => {
    expect(Array.from(float32ToInt16(new Float32Array([2, -2])))).toEqual([32767, -32768])
  })

  it('round-trips int16 within one quantization step', () => {
    const original = new Int16Array([0, 1000, -1000, 32767, -32768, 12345])
    const back = float32ToInt16(int16ToFloat32(original))
    for (let i = 0; i < original.length; i++) {
      expect(Math.abs(back[i] - original[i])).toBeLessThanOrEqual(1)
    }
  })
})

describe('downmixToMono', () => {
  it('averages stereo pairs', () => {
    const stereo = new Float32Array([1, 0, 0.5, -0.5, -1, -1])
    expect(Array.from(downmixToMono(stereo, 2))).toEqual([0.5, 0, -1])
  })

  it('returns mono input unchanged', () => {
    const mono = new Float32Array([0.1, 0.2, 0.3])
    expect(downmixToMono(mono, 1)).toBe(mono)
  })
})

describe('resampleMono', () => {
  it('returns the input untouched when rates match', () => {
    const input = new Float32Array([0.1, 0.2])
    expect(resampleMono(input, 16000, 16000)).toBe(input)
  })

  it('decimates an integer ratio by averaging groups (48k->16k)', () => {
    const input = new Float32Array([0, 3, 6, 9, 12, 15]) // two groups of 3
    expect(Array.from(resampleMono(input, 48000, 16000))).toEqual([3, 12]) // (0+3+6)/3, (9+12+15)/3
  })

  it('produces the expected length for 48k->16k', () => {
    expect(resampleMono(new Float32Array(480), 48000, 16000).length).toBe(160)
  })

  it('handles a non-integer ratio (44.1k->16k) without NaN, preserving range', () => {
    const input = new Float32Array(441).map((_, i) => Math.sin((2 * Math.PI * i) / 20))
    const out = resampleMono(input, 44100, 16000)
    expect(out.length).toBe(160) // round(441 * 16000 / 44100)
    expect(out.every((v) => Number.isFinite(v))).toBe(true)
    expect(Math.max(...out)).toBeLessThanOrEqual(1)
    expect(Math.min(...out)).toBeGreaterThanOrEqual(-1)
  })
})

describe('PcmResampler', () => {
  function f32Bytes(samples: number[]): Uint8Array {
    const buf = Buffer.alloc(samples.length * 4)
    samples.forEach((s, i) => buf.writeFloatLE(s, i * 4))
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  it('converts f32 48k stereo to 16k mono int16', () => {
    const r = new PcmResampler() // f32 / 48000 / 2ch by default
    // 3 stereo frames -> mono [0.5, 0.5, 0.5] -> averaged to one 16k sample.
    const out = r.process(f32Bytes([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]))
    expect(out.length).toBe(1)
    expect(Math.abs(out[0] - Math.round(0.5 * 0x7fff))).toBeLessThanOrEqual(1)
  })

  it('carries a partial sample-frame across chunks', () => {
    const r = new PcmResampler()
    const full = f32Bytes(new Array(18).fill(0.25)) // 9 stereo frames (72 bytes) -> 3 output samples
    const out1 = r.process(full.subarray(0, 30)) // 3 frames + 6 leftover bytes
    const out2 = r.process(full.subarray(30)) // 6 leftover + 6 frames
    expect(out1.length + out2.length).toBe(3)
    for (const v of [...out1, ...out2])
      expect(Math.abs(v - Math.round(0.25 * 0x7fff))).toBeLessThanOrEqual(1)
  })

  it('does not drop samples when a chunk is not a whole decimation group', () => {
    // Mono 48k→16k, factor 3. Feed 8 frames (not a multiple of 3): a naive
    // decimator would drop the trailing 2; the resampler must carry them.
    const r = new PcmResampler({ inputChannels: 1, inputSampleRate: 48000 })
    const out1 = r.process(f32Bytes(new Array(8).fill(0.5))) // 2 out, 2 carried
    const out2 = r.process(f32Bytes(new Array(7).fill(0.5))) // 2 carried + 7 = 9 → 3 out
    // 15 input samples total / 3 = exactly 5 output samples, none lost.
    expect(out1.length + out2.length).toBe(5)
  })

  it('carries decimation remainder across many small chunks without drift', () => {
    const r = new PcmResampler({ inputChannels: 1, inputSampleRate: 48000 })
    let produced = 0
    // 100 chunks of 50 mono samples = 5000 in → exactly 5000/3 groups.
    for (let i = 0; i < 100; i++) produced += r.process(f32Bytes(new Array(50).fill(0.1))).length
    expect(produced).toBe(Math.floor(5000 / 3))
  })

  it('reads s16 input', () => {
    const r = new PcmResampler({ format: 's16', inputSampleRate: 48000, inputChannels: 2 })
    const buf = Buffer.alloc(3 * 2 * 2) // 3 stereo frames of int16
    for (let i = 0; i < 6; i++) buf.writeInt16LE(16384, i * 2) // 0.5 of full scale
    const out = r.process(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
    expect(out.length).toBe(1)
    expect(Math.abs(out[0] - 16384)).toBeLessThanOrEqual(2)
  })
})
