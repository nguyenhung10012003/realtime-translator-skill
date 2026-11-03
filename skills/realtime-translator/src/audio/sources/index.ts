import type { AudioSource, Platform } from '../../types'
import { WindowsLoopbackSource } from './WindowsLoopbackSource'
import { MacosTapSource } from './MacosTapSource'
import { t } from '../../messages'

/**
 * A live-capture AudioSource. Beyond {@link AudioSource}, it can silence the
 * captured app's own output while capturing (dub-over) so the user hears only
 * the translated voice. Supported on macOS (Core Audio tap); a no-op on Windows
 * (WASAPI process loopback captures without a per-process mute).
 */
export interface LiveAudioSource extends AudioSource {
  setMuted(muted: boolean): void
}

/** Options for constructing a live AudioSource — the chosen capture target. */
export interface LiveSourceOptions {
  /** Process id to capture (string, as the loopback helper expects). */
  processId: string
  /** Surfaced when capture fails after a successful start. */
  onError?: (error: Error) => void
  /** Start with the captured app's own output silenced (dub-over mode). */
  muted?: boolean
}

/**
 * Resolves the live-capture AudioSource for the current OS.
 *
 * - win32  → WASAPI process loopback (Windows 10 2004+)
 * - darwin → Core Audio process tap (macOS 14.4+)
 */
export function createLiveAudioSource(
  platform: Platform,
  options: LiveSourceOptions,
): LiveAudioSource {
  switch (platform) {
    case 'win32':
      return new WindowsLoopbackSource(options.processId, { onError: options.onError })
    case 'darwin':
      return new MacosTapSource(options.processId, {
        onError: options.onError,
        muted: options.muted,
      })
    default:
      throw new Error(t('main.captureUnsupported', { platform }))
  }
}
