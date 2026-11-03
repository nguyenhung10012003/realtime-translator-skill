import type { AudioFrame } from '../../types'
import type { LiveAudioSource } from './index'
import { PcmFramer } from '../framing/PcmFramer'
import { PcmResampler, type PcmResamplerOptions } from '../resample/resamplePcm'
import { t } from '../../messages'

/** Real types come from the package itself; `typeof import` is erased at runtime. */
type Loopback = typeof import('application-loopback')

let cachedModule: Loopback | null = null

/**
 * Loads the native loopback helper lazily and only on Windows, so this module
 * imports cleanly on macOS/Linux (where the package is an unusable optional dep).
 */
export async function loadLoopback(): Promise<Loopback> {
  if (process.platform !== 'win32') {
    throw new Error(t('main.windowsOnly'))
  }
  if (!cachedModule) {
    cachedModule = await import('application-loopback').catch(() => {
      throw new Error(t('main.loopbackMissing'))
    })
  }
  return cachedModule
}

export interface WindowsLoopbackOptions extends PcmResamplerOptions {
  /** Surfaced when capture fails after a successful start. */
  onError?: (error: Error) => void
}

/**
 * Live AudioSource for Windows: per-process WASAPI loopback through the
 * `application-loopback` helper binary (spawned child process dumping raw PCM),
 * resampled to 16 kHz mono Int16 and re-chunked to 20 ms frames. Per-process
 * capture is how we avoid the feedback loop.
 *
 * The raw capture format is assumed to be the WASAPI mix format (f32/48k/2ch)
 * and is configurable via {@link PcmResamplerOptions} — confirm it against the
 * binary's real output on Windows.
 */
export class WindowsLoopbackSource implements LiveAudioSource {
  private readonly resampler: PcmResampler
  private framer: PcmFramer | null = null
  private loopback: Loopback | null = null

  constructor(
    private readonly processId: string,
    private readonly options: WindowsLoopbackOptions = {},
  ) {
    this.resampler = new PcmResampler(options)
  }

  async start(onFrame: (frame: AudioFrame) => void): Promise<void> {
    if (this.loopback) return // already capturing
    const loopback = await loadLoopback()
    const framer = new PcmFramer(onFrame)
    this.loopback = loopback
    this.framer = framer

    loopback.startAudioCapture(this.processId, {
      onData: (chunk) => {
        if (this.framer !== framer) return // stale callback after stop()
        try {
          const pcm = this.resampler.process(chunk)
          if (pcm.length) framer.push(pcm)
        } catch (error) {
          this.options.onError?.(error instanceof Error ? error : new Error(String(error)))
          void this.stop()
        }
      },
    })
  }

  async stop(): Promise<void> {
    const loopback = this.loopback
    const framer = this.framer
    this.loopback = null
    this.framer = null
    if (!loopback) return
    try {
      loopback.stopAudioCapture(this.processId)
    } finally {
      framer?.flush()
      this.resampler.reset()
    }
  }

  /**
   * No-op: WASAPI process loopback captures the app without muting its own
   * output. Silencing the source on Windows (e.g. per-session volume) is future
   * work; the app avoids feedback by capturing per-process, not by muting.
   */
  setMuted(_muted: boolean): void {}
}
