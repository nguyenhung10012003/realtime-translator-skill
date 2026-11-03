import { spawn, type ChildProcess } from 'node:child_process'
import type { AudioFrame } from '../../types'
import type { LiveAudioSource } from './index'
import { PcmFramer } from '../framing/PcmFramer'
import { PcmResampler } from '../resample/resamplePcm'
import { parseTapHeader, resolveTapHelperPath, tapExitMessage } from '../macos/tapHelper'
import { t } from '../../messages'

export interface MacosTapOptions {
  /** Surfaced when capture fails after a successful start. */
  onError?: (error: Error) => void
  /** Start with the captured app's own output silenced (dub-over mode). */
  muted?: boolean
}

/**
 * Generous because the very first start can sit behind the macOS TCC prompt
 * ("System Audio Recording") — the helper only streams once that's answered.
 */
const START_TIMEOUT_MS = 30_000

/**
 * Live AudioSource for macOS 14.4+: per-process capture through the bundled
 * Core Audio tap helper (native/macos/AudioTap.m), which streams a mono
 * mixdown of the target app as raw PCM on stdout — resampled here to 16 kHz
 * mono Int16 and re-chunked to 20 ms frames. Per-process capture is how we
 * avoid the feedback loop.
 *
 * Can silence the captured app's own output while capturing (dub-over): the tap
 * still receives the audio to translate, the user just hears the translation
 * instead of the original. Toggled live via a stdin command to the helper.
 */
export class MacosTapSource implements LiveAudioSource {
  private child: ChildProcess | null = null
  private framer: PcmFramer | null = null
  private muted: boolean

  constructor(
    private readonly processId: string,
    private readonly options: MacosTapOptions = {},
  ) {
    this.muted = options.muted ?? false
  }

  async start(onFrame: (frame: AudioFrame) => void): Promise<void> {
    if (this.child) return // already capturing
    const helperPath = await resolveTapHelperPath()

    const args = ['tap', this.processId, ...(this.muted ? ['--muted'] : [])]
    const child = spawn(helperPath, args, {
      // stdin is piped so we can send mute/unmute commands to the running helper.
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    // A vanished helper makes stdin writes throw EPIPE; swallow — capture teardown
    // is handled by the close/error paths below.
    child.stdin?.on('error', () => undefined)

    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000)
    })

    const framer = new PcmFramer(onFrame)
    let resampler: PcmResampler | null = null
    /** Non-null while we're still waiting for the header line. */
    let headerBuffer: Buffer | null = Buffer.alloc(0)

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(startTimer)
        if (error) reject(error)
        else resolve()
      }
      const startTimer = setTimeout(() => {
        settle(new Error(t('tap.startTimeout')))
        void this.stop()
      }, START_TIMEOUT_MS)

      child.stdout?.on('data', (chunk: Buffer) => {
        if (this.child !== child) return // stale after stop()

        if (headerBuffer !== null) {
          headerBuffer = Buffer.concat([headerBuffer, chunk])
          const newline = headerBuffer.indexOf(0x0a)
          if (newline === -1) {
            if (headerBuffer.length > 512) {
              settle(new Error(t('tap.invalidData')))
              void this.stop()
            }
            return
          }
          const header = parseTapHeader(headerBuffer.subarray(0, newline).toString('utf8'))
          if (!header) {
            settle(new Error(t('tap.invalidHeader')))
            void this.stop()
            return
          }
          resampler = new PcmResampler({
            inputSampleRate: header.sampleRate,
            inputChannels: header.channels,
            format: header.format,
          })
          chunk = headerBuffer.subarray(newline + 1)
          headerBuffer = null
          settle()
          if (chunk.length === 0) return
        }

        try {
          const pcm = (resampler as PcmResampler).process(chunk)
          if (pcm.length) framer.push(pcm)
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)))
        }
      })

      child.on('error', (error) => {
        if (this.child === child) this.child = null
        const wasStreaming = headerBuffer === null
        settle(error) // no-op if the start already succeeded
        if (wasStreaming) this.options.onError?.(error)
      })

      child.on('close', (code) => {
        if (this.child !== child) {
          // stop() killed us while still waiting for the header — unblock the
          // pending start() now instead of hanging until the 30s timeout.
          settle(new Error(t('tap.stoppedBeforeStart')))
          return
        }
        this.child = null
        const error = new Error(tapExitMessage(code, stderrTail))
        if (headerBuffer !== null) {
          settle(error) // died before ever streaming → fail the start()
        } else {
          framer.flush()
          this.options.onError?.(error) // died mid-capture → runtime error
        }
      })
    })

    this.framer = framer
  }

  /**
   * Silences (or restores) the captured app's own output while still capturing
   * it. The helper rebuilds its tap on the same stdout stream, so a live toggle
   * costs only a brief capture gap. No-op before capture starts.
   */
  setMuted(muted: boolean): void {
    if (muted === this.muted) return
    this.muted = muted
    this.child?.stdin?.write(muted ? 'mute\n' : 'unmute\n')
  }

  async stop(): Promise<void> {
    const child = this.child
    const framer = this.framer
    this.child = null
    this.framer = null
    if (child) child.kill() // SIGTERM → helper tears the tap down and exits 0
    framer?.flush()
  }

  private fail(error: Error): void {
    this.options.onError?.(error)
    void this.stop()
  }
}
