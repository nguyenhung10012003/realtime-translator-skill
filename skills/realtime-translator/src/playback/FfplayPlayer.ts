import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { describeSpawnError } from '../audio/ffmpegPath'

/** Plays streaming 16-bit mono PCM as it arrives. */
export interface PcmPlayer {
  /** Throws when playback is unavailable, so callers fail before streaming billed audio. */
  start(): void
  write(pcm: Int16Array): void
  /** Lets queued audio finish briefly, then releases the device. */
  stop(): Promise<void>
}

const SAMPLE_RATE = 24_000
/** How long stop() lets already-queued audio play out before killing the player. */
const DRAIN_MS = 1_500

/**
 * Pipes PCM into `ffplay`, because continuous speech needs one open output rather than a
 * process per chunk. Raw `s16le` is mono by default, so no channel flag is passed; its
 * spelling differs across ffmpeg versions.
 */
export class FfplayPlayer implements PcmPlayer {
  private child: ChildProcess | null = null
  private readonly path: string
  private readonly onError: (message: string) => void

  constructor(options: { onError?: (message: string) => void } = {}) {
    this.path = process.env.RTT_FFPLAY_PATH?.trim() || 'ffplay'
    this.onError = options.onError ?? (() => undefined)
  }

  start(): void {
    const probe = spawnSync(this.path, ['-version'], { stdio: 'ignore' })
    if (probe.error) throw describeSpawnError('ffplay', this.path, probe.error)

    const child = spawn(
      this.path,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nodisp',
        '-autoexit',
        '-fflags',
        'nobuffer',
        '-flags',
        'low_delay',
        '-probesize',
        '32',
        '-analyzeduration',
        '0',
        '-f',
        's16le',
        '-sample_rate',
        String(SAMPLE_RATE),
        '-i',
        '-',
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    )
    this.child = child

    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-500)
    })
    // A vanished player makes stdin writes throw EPIPE; the close handler reports it.
    child.stdin?.on('error', () => undefined)
    child.on('error', (error) =>
      this.onError(describeSpawnError('ffplay', this.path, error).message),
    )
    child.on('close', (code) => {
      if (this.child !== child) return // stop() asked for this
      this.child = null
      this.onError(`ffplay stopped (code ${code}), voice playback is off. ${stderrTail.trim()}`)
    })
  }

  write(pcm: Int16Array): void {
    if (pcm.length === 0) return
    this.child?.stdin?.write(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    if (!child) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill(), DRAIN_MS)
      child.on('close', () => {
        clearTimeout(timer)
        resolve()
      })
      child.stdin?.end()
    })
  }
}
