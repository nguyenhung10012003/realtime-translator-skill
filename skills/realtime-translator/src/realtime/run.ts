import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { SAMPLE_RATE } from '../audio/constants'
import { createLiveAudioSource } from '../audio/sources'
import { StdinSource } from '../audio/sources/StdinSource'
import { encodeMp3 } from '../export/encodeMp3'
import { pcm16ToWav } from '../export/wav'
import type { JobStore } from '../job/store'
import { FfplayPlayer, type PcmPlayer } from '../playback/FfplayPlayer'
import type { AudioSource } from '../types'
import { CaptionPairer, type Caption } from './captions'
import { RealtimeSession } from './session'

const OUTPUT_RATE = 24_000

export interface RealtimeOptions {
  job: JobStore
  processId?: string
  stdin: boolean
  provider: string
  model?: string
  targetLanguage: string
  durationSec?: number
  play: boolean
  muteSource: boolean
  /** Saves the provider's translated speech here when the session ends. */
  audioOut?: string
  emit: (event: Record<string, unknown>) => void
}

/**
 * Streams audio straight to a speech-to-speech model. There is no segmenting and no
 * translation step here: the provider does all of it, and captions are reconstructed
 * from its transcript fragments so `render --srt` still works afterwards.
 */
export async function runRealtime(options: RealtimeOptions): Promise<void> {
  const { job, emit } = options
  const player: PcmPlayer | null = options.play
    ? new FfplayPlayer({ onError: (message) => emit({ type: 'warning', message }) })
    : null
  // Fails fast when ffplay is missing, before any billed audio is streamed.
  player?.start()

  job.create({
    mode: 'live',
    source: options.stdin ? 'stdin' : `process:${options.processId}`,
    targetLanguage: options.targetLanguage,
    sourceLanguage: null,
  })
  writeFileSync(job.pidFile(), String(process.pid))

  const audioFile = options.audioOut ? join(job.dir, 'realtime.pcm') : null
  const audioFd = audioFile ? openSync(audioFile, 'w') : null

  let fatal: Error | null = null
  let requestStop: () => void = () => undefined
  const stopped = new Promise<void>((resolve) => {
    requestStop = resolve
  })

  let sentMs = 0
  let startedAt = 0
  let firstOutput = false
  let nextId = 1
  const captions = new CaptionPairer()

  const record = (caption: Caption | null): void => {
    if (!caption) return
    const segment = job.addSegment(
      { startMs: caption.startMs, endMs: caption.endMs, text: caption.source },
      nextId++,
    )
    job.addTranslations([{ id: segment.id, text: caption.translation }])
    emit({ type: 'segment', ...segment })
    emit({ type: 'translation', id: segment.id, text: caption.translation })
  }

  const noteFirstOutput = (): void => {
    if (firstOutput) return
    firstOutput = true
    emit({ type: 'status', status: 'first_output', afterMs: Date.now() - startedAt })
  }

  const session = RealtimeSession.create(
    options.provider,
    { model: options.model, language: options.targetLanguage },
    {
      onAudio: (pcm) => {
        noteFirstOutput()
        player?.write(pcm)
        if (audioFd !== null) {
          writeSync(audioFd, new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
        }
      },
      onSourceText: (delta) => captions.addSource(delta, sentMs),
      onTranslatedText: (delta) => {
        noteFirstOutput()
        record(captions.addTranslation(delta, sentMs))
      },
      onReconnecting: () => emit({ type: 'status', status: 'reconnecting' }),
      onReconnected: () => emit({ type: 'status', status: 'capturing' }),
      onWarning: (message) => emit({ type: 'warning', message }),
      onFatal: (error) => {
        fatal = error
        requestStop()
      },
    },
  )

  const source: AudioSource = options.stdin
    ? new StdinSource(process.stdin, requestStop)
    : createLiveAudioSource(process.platform, {
        processId: options.processId as string,
        muted: options.muteSource,
        onError: (error) => {
          fatal = error
          requestStop()
        },
      })

  const onSignal = (): void => requestStop()
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  const durationTimer =
    options.durationSec === undefined ? null : setTimeout(requestStop, options.durationSec * 1000)

  try {
    await session.connect()
    startedAt = Date.now()
    await source.start((frame) => {
      session.send(frame.pcm)
      sentMs = frame.timestampMs + (frame.pcm.length / SAMPLE_RATE) * 1000
    })
    emit({ type: 'status', status: 'capturing', pid: process.pid, provider: options.provider })
    await stopped

    await source.stop()
    if (!fatal) {
      emit({ type: 'status', status: 'draining' })
      await session.finish()
    }
    record(captions.finish(sentMs))
    emit({ type: 'status', status: 'stopped', pending: 0 })
  } finally {
    session.close()
    await source.stop().catch(() => undefined)
    if (durationTimer) clearTimeout(durationTimer)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await player?.stop()
    if (audioFd !== null) closeSync(audioFd)
    job.update({ finished: true })
    rmSync(job.pidFile(), { force: true })
  }

  // Whatever arrived before a failure is still worth keeping.
  if (audioFile && options.audioOut) {
    const bytes = readFileSync(audioFile)
    if (bytes.length > 0) {
      const pcm = new Int16Array(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length - (bytes.length % 2)),
      )
      mkdirSync(dirname(options.audioOut), { recursive: true })
      if (extname(options.audioOut).toLowerCase() === '.mp3') {
        await encodeMp3(pcm, OUTPUT_RATE, options.audioOut)
      } else {
        writeFileSync(options.audioOut, pcm16ToWav(pcm, OUTPUT_RATE))
      }
      emit({ type: 'audio', path: options.audioOut })
    }
    rmSync(audioFile, { force: true })
  }

  if (fatal) throw fatal
}
