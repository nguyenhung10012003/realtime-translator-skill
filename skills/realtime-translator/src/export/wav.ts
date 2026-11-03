// Minimal WAV writing. Speech here is
// 16-bit mono PCM, so a plain 44-byte RIFF header in front of the samples
// is all a .wav needs.

/** Concatenates PCM chunks into one contiguous buffer. */
export function concatInt16(chunks: readonly Int16Array[]): Int16Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Int16Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** Wraps 16-bit mono LE PCM in a RIFF/WAVE container. */
export function pcm16ToWav(pcm: Int16Array, sampleRate: number): Buffer {
  const dataBytes = pcm.length * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16) // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20) // audio format = PCM
  buffer.writeUInt16LE(1, 22) // channels = mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28) // byte rate
  buffer.writeUInt16LE(2, 32) // block align
  buffer.writeUInt16LE(16, 34) // bits per sample
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataBytes, 40)
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buffer, 44)
  return buffer
}
