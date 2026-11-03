// Audio format shared across every AudioSource: the 16 kHz mono 16-bit LE PCM that
// whisper.cpp consumes.

/** Input sample rate of the whole pipeline. */
export const SAMPLE_RATE = 16_000

/** Frame duration: the framer adds at most one frame of buffering. */
export const FRAME_MS = 20

/** Samples per frame: 16000 Hz × 0.02 s = 320 (mono). */
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000

/** Bytes per frame: 320 samples × 2 bytes (16-bit). */
export const FRAME_BYTES = FRAME_SAMPLES * 2
