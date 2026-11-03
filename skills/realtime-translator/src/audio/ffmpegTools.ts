import { spawn } from 'node:child_process'
import { describeSpawnError, ffmpegPath } from './ffmpegPath'

/** Runs ffmpeg, returning stdout. Rejects with its stderr on failure. */
function runFfmpeg(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args])
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2_000)
    })
    child.stdin.on('error', () => undefined)
    child.on('error', (error) => reject(describeSpawnError('ffmpeg', ffmpegPath, error)))
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`))
    })
    child.stdin.end(input)
  })
}

const asInt16 = (bytes: Buffer): Int16Array => {
  const even = bytes.byteLength - (bytes.byteLength % 2)
  return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + even))
}

/** Decodes any audio (or a video's audio track) to a mono 16-bit WAV file. */
export async function decodeToWav(input: string, output: string, rate: number): Promise<void> {
  await runFfmpeg([
    '-y',
    '-i',
    input,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(rate),
    '-c:a',
    'pcm_s16le',
    output,
  ])
}

/** Decodes any audio file to mono 16-bit PCM samples. */
export async function decodeToPcm(input: string, rate: number): Promise<Int16Array> {
  return asInt16(
    await runFfmpeg(['-i', input, '-ac', '1', '-ar', String(rate), '-f', 's16le', '-']),
  )
}

/** Speeds speech up without changing its pitch. */
export async function changeTempo(
  pcm: Int16Array,
  rate: number,
  tempo: number,
): Promise<Int16Array> {
  const input = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  return asInt16(
    await runFfmpeg(
      [
        '-f',
        's16le',
        '-ar',
        String(rate),
        '-ac',
        '1',
        '-i',
        '-',
        '-filter:a',
        `atempo=${tempo.toFixed(3)}`,
        '-f',
        's16le',
        '-',
      ],
      input,
    ),
  )
}
