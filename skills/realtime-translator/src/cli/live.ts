import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { SAMPLE_RATE } from '../audio/constants'
import { Segmenter, type SegmenterOptions, type Utterance } from '../audio/segmenter'
import { createLiveAudioSource } from '../audio/sources'
import { StdinSource } from '../audio/sources/StdinSource'
import type { JobStore, Segment } from '../job/store'
import { ProviderAuthError } from '../providers/http'
import type { PcmRecognizer } from '../stt/cloud'
import { recentContext, translateBatch, type Completion } from '../translate/translator'
import type { Speaker } from '../tts/tts'
import type { AudioSource } from '../types'

export interface LiveOptions {
  job: JobStore
  processId?: string
  stdin: boolean
  targetLanguage: string
  sourceLanguage?: string
  recognizer: PcmRecognizer
  /** Reads translations aloud when set. */
  speaker: Speaker | null
  durationSec?: number
  muteSource: boolean
  translatorCmd?: string
  /** Translates through a provider, instead of waiting for the agent. */
  completion?: Completion
  /** After capture ends, how long to wait for translations still on their way. */
  drainSec: number
  /** How speech is cut, which is what most separates the chunked latency levels. */
  segmentation?: SegmenterOptions
  emit: (event: Record<string, unknown>) => void
}

const POLL_MS = 250
/** More unspoken lines than this means speech is too far behind to be useful. */
const MAX_SPEECH_BACKLOG = 3
const TRANSLATOR_TIMEOUT_MS = 60_000

/** Pipes one segment through a user-supplied translator command. */
export function runTranslatorCommand(
  command: string,
  text: string,
  targetLanguage: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, RTT_TARGET_LANGUAGE: targetLanguage },
    })
    const timer = setTimeout(() => child.kill(), TRANSLATOR_TIMEOUT_MS)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-500)
    })
    child.stdin.on('error', () => undefined)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const translated = stdout.trim()
      if (code === 0 && translated) resolve(translated)
      else reject(new Error(`translator exited with code ${code}: ${stderr.trim()}`))
    })
    child.stdin.end(text)
  })
}

/**
 * Captures audio, cuts it into utterances, transcribes them one at a time, and speaks
 * each translation as it appears in the job. Translations come from the agent through
 * `push`, from a provider, or from `translatorCmd`.
 */
export async function runLive(options: LiveOptions): Promise<void> {
  const { job, emit, recognizer, speaker } = options

  job.create({
    mode: 'live',
    source: options.stdin ? 'stdin' : `process:${options.processId}`,
    targetLanguage: options.targetLanguage,
    sourceLanguage: options.sourceLanguage ?? null,
  })
  writeFileSync(job.pidFile(), String(process.pid))

  let nextId = 1
  let fatalError: Error | null = null
  let requestStop: () => void = () => undefined
  const stopped = new Promise<void>((resolve) => {
    requestStop = resolve
  })

  const report = (error: unknown): void => {
    if (error instanceof ProviderAuthError) {
      // Every later call would fail the same way, and could be billed.
      fatalError = error
      requestStop()
      return
    }
    emit({ type: 'warning', message: error instanceof Error ? error.message : String(error) })
  }

  // Translation has its own queue, so a slow provider doesn't hold up recognition.
  let translation: Promise<void> = Promise.resolve()
  const translate = (segment: Segment): void => {
    const { completion, translatorCmd } = options
    if (!completion && !translatorCmd) return
    translation = translation.then(async () => {
      try {
        if (completion) {
          const results = await translateBatch(
            completion,
            [segment],
            options.targetLanguage,
            recentContext(job),
          )
          if (results.length > 0) job.addTranslations(results)
          else emit({ type: 'warning', message: `no translation for segment ${segment.id}` })
        } else if (translatorCmd) {
          const text = await runTranslatorCommand(
            translatorCmd,
            segment.text,
            options.targetLanguage,
          )
          job.addTranslations([{ id: segment.id, text }])
        }
      } catch (error) {
        report(error)
      }
    })
  }

  // Recognition is serial, because order must be preserved.
  let recognition: Promise<void> = Promise.resolve()
  const enqueue = (utterance: Utterance): void => {
    recognition = recognition.then(async () => {
      try {
        const result = await recognizer.transcribePcm(utterance.pcm, SAMPLE_RATE)
        const text = result.segments
          .map((segment) => segment.text)
          .join(' ')
          .trim()
        if (!text) return
        const segment = job.addSegment(
          { startMs: utterance.startMs, endMs: utterance.endMs, text },
          nextId++,
        )
        emit({ type: 'segment', ...segment })
        translate(segment)
      } catch (error) {
        report(error)
      }
    })
  }

  // Speak translations in segment order; drop the oldest rather than fall behind.
  const announced = new Set<number>()
  const speechQueue: string[] = []
  let speaking = false
  const pump = (): void => {
    if (!speaker || speaking) return
    const text = speechQueue.shift()
    if (text === undefined) return
    speaking = true
    speaker
      .speak(text)
      .catch((error) => emit({ type: 'warning', message: `speech failed: ${String(error)}` }))
      .finally(() => {
        speaking = false
        pump()
      })
  }
  const pollTranslations = (): void => {
    const translations = job.translations()
    for (const segment of job.segments()) {
      const text = translations.get(segment.id)
      if (text === undefined || announced.has(segment.id)) continue
      announced.add(segment.id)
      emit({ type: 'translation', id: segment.id, text })
      if (speaker) {
        speechQueue.push(text)
        while (speechQueue.length > MAX_SPEECH_BACKLOG) {
          speechQueue.shift()
          emit({ type: 'warning', message: 'speech fell behind; skipped a line' })
        }
      }
    }
    pump()
  }
  const poller = setInterval(pollTranslations, POLL_MS)

  const segmenter = new Segmenter(enqueue, options.segmentation)
  const source: AudioSource = options.stdin
    ? new StdinSource(process.stdin, requestStop)
    : createLiveAudioSource(process.platform, {
        processId: options.processId as string,
        muted: options.muteSource,
        onError: (error) => {
          fatalError = error
          requestStop()
        },
      })

  const onSignal = (): void => requestStop()
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  const durationTimer =
    options.durationSec === undefined ? null : setTimeout(requestStop, options.durationSec * 1000)

  try {
    await source.start((frame) => segmenter.push(frame))
    emit({ type: 'status', status: 'capturing', pid: process.pid })
    await stopped

    await source.stop()
    segmenter.flush()
    await recognition
    await translation
    job.update({ finished: true })
    emit({ type: 'status', status: 'draining', pending: job.pending().length })

    // Give the agent a moment to finish what is already recognized.
    const deadline = Date.now() + options.drainSec * 1000
    while (!fatalError && job.pending().length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    pollTranslations()
    while (speaking || speechQueue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    emit({ type: 'status', status: 'stopped', pending: job.pending().length })
  } finally {
    clearInterval(poller)
    if (durationTimer) clearTimeout(durationTimer)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    job.update({ finished: true })
    rmSync(job.pidFile(), { force: true })
  }

  if (fatalError) throw fatalError
}
