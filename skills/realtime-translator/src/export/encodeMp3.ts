import { spawn } from 'node:child_process'
import { describeSpawnError, ffmpegPath } from '../audio/ffmpegPath'

/**
 * Encodes 16-bit mono LE PCM to an MP3 file via ffmpeg (libmp3lame, VBR ~190 kbps). Rejects with ffmpeg's stderr on failure.
 */
export function encodeMp3(pcm: Int16Array, sampleRate: number, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      's16le',
      '-ar',
      String(sampleRate),
      '-ac',
      '1',
      '-i',
      '-',
      '-codec:a',
      'libmp3lame',
      '-q:a',
      '2',
      '-y',
      outputPath,
    ])

    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => reject(describeSpawnError('ffmpeg', ffmpegPath, error)))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`))
    })

    // EPIPE surfaces via the child 'error'/'close' path; swallow the stream copy.
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
  })
}
