// Contracts shared by the audio sources and the CLI.

export type Platform = NodeJS.Platform

/** One chunk of mono 16-bit little-endian PCM at 16 kHz, what whisper.cpp consumes. */
export interface AudioFrame {
  /** Raw 16-bit LE PCM samples, mono, 16 kHz. */
  pcm: Int16Array
  /** Milliseconds since the source started. */
  timestampMs: number
}

/** Any live audio input. Every implementation emits 16 kHz mono PCM frames. */
export interface AudioSource {
  /** Begin producing frames; `onFrame` fires for each chunk. */
  start(onFrame: (frame: AudioFrame) => void): Promise<void>
  /** Stop capture and release native resources. */
  stop(): Promise<void>
}

/** A capture target for live mode (one running app). `id` is a process id, as a string. */
export interface AudioProcess {
  id: string
  /** Human-readable label — window title or app name, falling back to `PID <id>`. */
  name: string
}
