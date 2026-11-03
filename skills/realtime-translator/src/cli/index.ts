#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs, type ParseArgsConfig } from 'node:util'
import { FRAME_SAMPLES, SAMPLE_RATE } from '../audio/constants'
import { decodeToPcm, decodeToWav } from '../audio/ffmpegTools'
import { listAudioProcesses } from '../audio/processes'
import { Segmenter, type Utterance } from '../audio/segmenter'
import { JobStore, type Translation } from '../job/store'
import {
  assessLevels,
  LATENCY_LEVELS,
  realtimeSupports,
  SEGMENTATION,
  type LatencyLevel,
} from '../latency/levels'
import { runRealtime } from '../realtime/run'
import { providersWith, resolveProvider, UnsupportedProviderError } from '../providers/registry'
import { render, type TrackSelection } from '../render/render'
import { createCloudRecognizer, type PcmRecognizer } from '../stt/cloud'
import {
  createWhisper,
  findWhisperCli,
  findWhisperModel,
  MissingDependencyError,
} from '../stt/whisper'
import { createCompletion, drainJob, type Completion } from '../translate/translator'
import { createCloudSpeaker } from '../tts/cloud'
import { chooseVoice, createSpeaker, listVoices, localePrefix, type Speaker } from '../tts/tts'
import { runLive } from './live'

const EXIT = { OK: 0, FAILED: 1, USAGE: 2, MISSING_DEPENDENCY: 3, RUNTIME: 4, INCOMPLETE: 5 }

class UsageError extends Error {}

const LOCAL_STT = 'local'
const SYSTEM_TTS = 'system'
/** Long enough for whole sentences when timing, not latency, is what matters. */
const FILE_MAX_UTTERANCE_MS = 30_000
const FILE_STT_CONCURRENCY = 4
const DEFAULT_BATCH = 30

const USAGE = `translator <command> [options]

  transcribe <audio> --job <dir> [-l <target>] [--source-lang <code>] [--model <path>]
             [--stt local|<provider>] [--stt-model <id>]
  next       --job <dir> [--limit <n>] [--wait <seconds>]
  push       --job <dir> [--file <json>]        reads [{"id":1,"text":"..."}] from stdin by default
  translate  --job <dir> --provider <provider> [--model <id>] [--batch <n>]
  status     --job <dir>
  render     --job <dir> [--srt <path>] [--vtt <path>] [--audio <path>] [--track both|source|translated]
             [--voice <name>] [--tts system|<provider>] [--tts-model <id>] [--allow-partial]
  levels     [-l <target>]                      which latency levels work on this machine
  live       --job <dir> (-p <pid> | --stdin) [-l <target>] [--duration <seconds>] [--play]
             [--latency careful|balanced|fast|realtime]
             [--realtime-provider openai|gemini] [--realtime-model <id>] [--audio <path>]
             [--mute-source] [--voice <name>] [--drain <seconds>] [--source-lang <code>] [--model <path>]
             [--stt local|<provider>] [--stt-model <id>]
             [--translator <provider>] [--translate-model <id>] [--translator-cmd <command>]
             [--tts system|<provider>] [--tts-model <id>]
  stop       --job <dir>
  list                                          apps that can be captured
  voices     [-l <lang>]                        system voices

Providers: openai, gemini, anthropic, groq, openrouter, ollama. See references/providers.md.
All commands print JSON on stdout. See references/cli.md.`

const print = (value: unknown): void => void process.stdout.write(`${JSON.stringify(value)}\n`)

type Options = NonNullable<ParseArgsConfig['options']>

function parse(args: string[], options: Options, positionals = false) {
  try {
    return parseArgs({ args, options, allowPositionals: positionals })
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
}

function jobFrom(value: unknown, mustExist = true): JobStore {
  if (typeof value !== 'string' || !value) throw new UsageError('--job <dir> is required.')
  const job = new JobStore(value)
  if (mustExist && !job.exists()) throw new UsageError(`No job at ${job.dir}.`)
  return job
}

function positiveNumber(flag: string, value: unknown): number | undefined {
  if (value === undefined) return undefined
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) {
    throw new UsageError(`${flag} must be a positive number (got "${String(value)}").`)
  }
  return number
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

function speakerFor(
  tts: string | undefined,
  model: string | undefined,
  voice: string | undefined,
  language: string,
): Speaker {
  if (!tts || tts === SYSTEM_TTS) return createSpeaker(language, voice)
  return createCloudSpeaker({ provider: tts, model, voice })
}

/**
 * Transcribes a file through a chunk-only recognizer. Our own segmentation supplies the
 * timing, so this works with any provider, including those that return no timestamps,
 * and keeps each request under upload limits.
 */
async function transcribeByUtterance(
  recognizer: PcmRecognizer,
  inputPath: string,
  job: JobStore,
): Promise<number> {
  const pcm = await decodeToPcm(inputPath, SAMPLE_RATE)
  const utterances: Utterance[] = []
  const segmenter = new Segmenter((utterance) => utterances.push(utterance), {
    maxUtteranceMs: FILE_MAX_UTTERANCE_MS,
  })
  for (let offset = 0; offset < pcm.length; offset += FRAME_SAMPLES) {
    segmenter.push({
      pcm: pcm.subarray(offset, offset + FRAME_SAMPLES),
      timestampMs: (offset / SAMPLE_RATE) * 1000,
    })
  }
  segmenter.flush()

  const texts = new Array<string>(utterances.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < utterances.length) {
      const index = cursor++
      const result = await recognizer.transcribePcm(utterances[index].pcm, SAMPLE_RATE)
      texts[index] = result.segments
        .map((segment) => segment.text)
        .join(' ')
        .trim()
      process.stderr.write(`recognized ${index + 1}/${utterances.length}\n`)
    }
  }
  await Promise.all(Array.from({ length: FILE_STT_CONCURRENCY }, worker))

  let id = 0
  utterances.forEach((utterance, index) => {
    if (texts[index]) {
      job.addSegment(
        { startMs: utterance.startMs, endMs: utterance.endMs, text: texts[index] },
        ++id,
      )
    }
  })
  return id
}

async function transcribe(args: string[]): Promise<number> {
  const { values, positionals } = parse(
    args,
    {
      job: { type: 'string' },
      lang: { type: 'string', short: 'l', default: 'vi' },
      'source-lang': { type: 'string' },
      model: { type: 'string' },
      stt: { type: 'string', default: LOCAL_STT },
      'stt-model': { type: 'string' },
    },
    true,
  )
  const input = positionals[0]
  if (!input) throw new UsageError('An input audio file is required.')
  const inputPath = resolve(input)
  if (!existsSync(inputPath)) throw new UsageError(`Input file not found: ${inputPath}`)
  const job = jobFrom(values.job, false)
  const language = str(values['source-lang'])
  const stt = str(values.stt) as string

  // Build the recognizer first, so a missing dependency can't clobber an existing job.
  const whisper = stt === LOCAL_STT ? createWhisper({ language, model: str(values.model) }) : null
  const cloud =
    stt === LOCAL_STT
      ? null
      : createCloudRecognizer({ provider: stt, model: str(values['stt-model']), language })

  job.create({
    mode: 'file',
    source: inputPath,
    targetLanguage: str(values.lang) as string,
    sourceLanguage: language ?? null,
  })

  let segments: number
  let detected: string | null = language ?? null
  if (whisper) {
    const wav = `${job.dir}/audio.16k.wav`
    await decodeToWav(inputPath, wav, SAMPLE_RATE)
    const result = await whisper.transcribeFile(wav)
    result.segments.forEach((segment, index) => job.addSegment(segment, index + 1))
    segments = result.segments.length
    detected = result.language
  } else {
    segments = await transcribeByUtterance(cloud as PcmRecognizer, inputPath, job)
  }
  job.update({ finished: true, sourceLanguage: detected })

  print({
    job: job.dir,
    sourceLanguage: detected,
    targetLanguage: job.info().targetLanguage,
    segments,
  })
  return EXIT.OK
}

async function next(args: string[]): Promise<number> {
  const { values } = parse(args, {
    job: { type: 'string' },
    limit: { type: 'string' },
    wait: { type: 'string' },
  })
  const job = jobFrom(values.job)
  const limit = positiveNumber('--limit', values.limit) ?? DEFAULT_BATCH
  const waitSec = positiveNumber('--wait', values.wait) ?? 0

  const deadline = Date.now() + waitSec * 1000
  while (job.pending().length === 0 && !job.info().finished && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 200))
  }

  const pending = job.pending(limit)
  const translations = job.translations()
  const translated = job.segments().filter((segment) => translations.has(segment.id))
  const info = job.info()
  print({
    targetLanguage: info.targetLanguage,
    pending,
    remaining: job.pending().length,
    finished: info.finished,
    // The last lines, so a batch keeps names and tone consistent with what came before.
    context: translated.slice(-3).map((segment) => ({
      source: segment.text,
      translation: translations.get(segment.id),
    })),
  })
  return EXIT.OK
}

function push(args: string[]): number {
  const { values } = parse(args, { job: { type: 'string' }, file: { type: 'string' } })
  const job = jobFrom(values.job)
  const raw = readFileSync(str(values.file) ?? 0, 'utf8')
  let items: Translation[]
  try {
    items = JSON.parse(raw) as Translation[]
  } catch (error) {
    throw new UsageError(`Translations must be JSON: ${String(error)}`)
  }
  if (!Array.isArray(items)) throw new UsageError('Translations must be a JSON array.')
  try {
    job.addTranslations(items)
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  print({ accepted: items.length, remaining: job.pending().length })
  return EXIT.OK
}

async function translate(args: string[]): Promise<number> {
  const { values } = parse(args, {
    job: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    'translate-model': { type: 'string' },
    batch: { type: 'string' },
  })
  const job = jobFrom(values.job)
  const provider = str(values.provider)
  if (!provider) throw new UsageError('--provider <provider> is required.')
  const completion = createCompletion(provider, str(values.model) ?? str(values['translate-model']))
  const result = await drainJob(job, completion, {
    batchSize: positiveNumber('--batch', values.batch) ?? DEFAULT_BATCH,
    onProgress: (done, remaining) =>
      process.stderr.write(`translated ${done}, ${remaining} remaining\n`),
  })
  print(result)
  return result.remaining === 0 ? EXIT.OK : EXIT.RUNTIME
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readPid(job: JobStore): number | null {
  if (!existsSync(job.pidFile())) return null
  const pid = Number(readFileSync(job.pidFile(), 'utf8'))
  return Number.isInteger(pid) && pid > 0 && isRunning(pid) ? pid : null
}

function status(args: string[]): number {
  const { values } = parse(args, { job: { type: 'string' } })
  const job = jobFrom(values.job)
  const info = job.info()
  print({
    ...info,
    segments: job.segments().length,
    remaining: job.pending().length,
    running: readPid(job) !== null,
  })
  return EXIT.OK
}

async function renderCommand(args: string[]): Promise<number> {
  const { values } = parse(args, {
    job: { type: 'string' },
    srt: { type: 'string' },
    vtt: { type: 'string' },
    audio: { type: 'string' },
    track: { type: 'string', default: 'both' },
    voice: { type: 'string' },
    tts: { type: 'string', default: SYSTEM_TTS },
    'tts-model': { type: 'string' },
    'allow-partial': { type: 'boolean', default: false },
  })
  const job = jobFrom(values.job)
  const track = values.track as TrackSelection
  if (!['both', 'source', 'translated'].includes(track)) {
    throw new UsageError(`--track must be both, source, or translated (got "${track}").`)
  }
  const srt = str(values.srt)
  const vtt = str(values.vtt)
  const audio = str(values.audio)
  if (!srt && !vtt && !audio) throw new UsageError('Pass at least one of --srt, --vtt, --audio.')

  const remaining = job.pending().length
  if (job.translations().size === 0) {
    process.stderr.write(
      'Error: this job has nothing translated, so there is nothing to render. Check that transcription succeeded.\n',
    )
    return EXIT.INCOMPLETE
  }
  if (remaining > 0 && !values['allow-partial']) {
    process.stderr.write(
      `Error: ${remaining} segments have no translation. Finish them with next/push or translate, or pass --allow-partial.\n`,
    )
    return EXIT.INCOMPLETE
  }

  const outputs = await render(job, {
    srt: srt && resolve(srt),
    vtt: vtt && resolve(vtt),
    audio: audio && resolve(audio),
    track,
    speaker: audio
      ? speakerFor(
          str(values.tts),
          str(values['tts-model']),
          str(values.voice),
          job.info().targetLanguage,
        )
      : undefined,
    onProgress: (done, total) => process.stderr.write(`speech ${done}/${total}\n`),
  })
  print({ outputs, untranslated: remaining })
  return EXIT.OK
}

async function live(args: string[]): Promise<number> {
  const { values } = parse(args, {
    job: { type: 'string' },
    process: { type: 'string', short: 'p' },
    stdin: { type: 'boolean', default: false },
    lang: { type: 'string', short: 'l', default: 'vi' },
    'source-lang': { type: 'string' },
    model: { type: 'string' },
    stt: { type: 'string', default: LOCAL_STT },
    'stt-model': { type: 'string' },
    translator: { type: 'string' },
    'translate-model': { type: 'string' },
    'translator-cmd': { type: 'string' },
    tts: { type: 'string', default: SYSTEM_TTS },
    'tts-model': { type: 'string' },
    latency: { type: 'string' },
    'realtime-provider': { type: 'string' },
    'realtime-model': { type: 'string' },
    audio: { type: 'string' },
    duration: { type: 'string' },
    play: { type: 'boolean', default: false },
    voice: { type: 'string' },
    'mute-source': { type: 'boolean', default: false },
    drain: { type: 'string' },
  })
  const job = jobFrom(values.job, false)
  if (Boolean(values.process) === Boolean(values.stdin)) {
    throw new UsageError('Pass exactly one of -p <pid> or --stdin.')
  }
  if (values.translator && values['translator-cmd']) {
    throw new UsageError('Pass only one of --translator or --translator-cmd.')
  }
  if (existsSync(job.pidFile()) && readPid(job) !== null) {
    throw new UsageError(`A live session is already running for ${job.dir}.`)
  }

  const targetLanguage = str(values.lang) as string
  const hasTranslator = Boolean(values.translator || values['translator-cmd'])
  const latency = (str(values.latency) ?? (hasTranslator ? 'balanced' : 'careful')) as LatencyLevel
  if (!LATENCY_LEVELS.includes(latency)) {
    throw new UsageError(
      `--latency must be one of ${LATENCY_LEVELS.join(', ')} (got "${latency}").`,
    )
  }

  if (latency === 'realtime') {
    const provider = str(values['realtime-provider'])
    if (!provider)
      throw new UsageError('--latency realtime needs --realtime-provider openai|gemini.')
    const ignored = [
      'translator',
      'translator-cmd',
      'tts-model',
      'stt-model',
      'voice',
      'model',
    ].filter((flag) => values[flag] !== undefined)
    if (values.stt !== LOCAL_STT) ignored.push('stt')
    if (values.tts !== SYSTEM_TTS) ignored.push('tts')
    if (ignored.length > 0) {
      throw new UsageError(
        `--latency realtime is one streaming session, so these do not apply: ${ignored.map((flag) => `--${flag}`).join(', ')}.`,
      )
    }
    if (!realtimeSupports(provider, targetLanguage)) {
      throw new UsageError(
        `${provider} realtime does not document "${targetLanguage}" as a target. Try --realtime-provider gemini, or --latency fast.`,
      )
    }
    // Checks the provider and key before anything touches the job directory.
    resolveProvider(provider, 'realtime', str(values['realtime-model']))
    mkdirSync(job.dir, { recursive: true })
    const audioOut = str(values.audio)
    await runRealtime({
      job,
      processId: str(values.process),
      stdin: values.stdin === true,
      provider,
      model: str(values['realtime-model']),
      targetLanguage,
      durationSec: positiveNumber('--duration', values.duration),
      play: values.play === true,
      muteSource: values['mute-source'] === true,
      audioOut: audioOut && resolve(audioOut),
      emit: print,
    })
    return EXIT.OK
  }

  if (values.audio !== undefined || values['realtime-provider'] !== undefined) {
    throw new UsageError(
      '--audio and --realtime-provider only apply to --latency realtime. Use render for other levels.',
    )
  }
  if ((latency === 'balanced' || latency === 'fast') && !hasTranslator) {
    throw new UsageError(
      `--latency ${latency} runs without you in the loop, so it needs --translator <provider> or --translator-cmd.`,
    )
  }

  const sourceLanguage = str(values['source-lang'])
  const stt = str(values.stt) as string
  const recognizer: PcmRecognizer =
    stt === LOCAL_STT
      ? createWhisper({ language: sourceLanguage, model: str(values.model) })
      : createCloudRecognizer({
          provider: stt,
          model: str(values['stt-model']),
          language: sourceLanguage,
        })
  const speaker: Speaker | null = values.play
    ? speakerFor(str(values.tts), str(values['tts-model']), str(values.voice), targetLanguage)
    : null
  const completion: Completion | undefined = values.translator
    ? createCompletion(str(values.translator) as string, str(values['translate-model']))
    : undefined

  mkdirSync(job.dir, { recursive: true })
  if (values['mute-source'] && !values.play) {
    print({
      type: 'warning',
      message: '--mute-source without --play leaves the user with silence.',
    })
  }
  await runLive({
    job,
    processId: str(values.process),
    stdin: values.stdin === true,
    targetLanguage,
    sourceLanguage,
    recognizer,
    speaker,
    completion,
    durationSec: positiveNumber('--duration', values.duration),
    muteSource: values['mute-source'] === true,
    translatorCmd: str(values['translator-cmd']),
    drainSec: positiveNumber('--drain', values.drain) ?? 15,
    segmentation: SEGMENTATION[latency],
    emit: print,
  })
  return EXIT.OK
}

function levels(args: string[]): number {
  const { values } = parse(args, { lang: { type: 'string', short: 'l', default: 'vi' } })
  const model = findWhisperModel()
  const ffplay = process.env.RTT_FFPLAY_PATH?.trim() || 'ffplay'
  print({
    targetLanguage: str(values.lang),
    levels: assessLevels({
      targetLanguage: str(values.lang) as string,
      localStt: findWhisperCli() !== null && model !== null && existsSync(model),
      sttProviders: providersWith('stt'),
      translators: providersWith('translate'),
      realtimeProviders: providersWith('realtime'),
      streamingPlayback: !spawnSync(ffplay, ['-version'], { stdio: 'ignore' }).error,
    }),
  })
  return EXIT.OK
}

function stop(args: string[]): number {
  const { values } = parse(args, { job: { type: 'string' } })
  const job = jobFrom(values.job)
  const pid = readPid(job)
  if (pid === null) {
    print({ stopped: false, reason: 'not running' })
    return EXIT.OK
  }
  process.kill(pid, 'SIGTERM')
  print({ stopped: true, pid })
  return EXIT.OK
}

async function list(): Promise<number> {
  print(await listAudioProcesses(process.platform))
  return EXIT.OK
}

function voices(args: string[]): number {
  const { values } = parse(args, { lang: { type: 'string', short: 'l' } })
  const all = listVoices()
  const lang = str(values.lang)
  if (!lang) {
    print(all)
    return EXIT.OK
  }
  const prefix = localePrefix(lang)
  print({
    default: chooseVoice(all, lang)?.name ?? null,
    voices: all.filter((voice) => voice.locale.toLowerCase().startsWith(prefix)),
  })
  return EXIT.OK
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2)
  switch (command) {
    case 'transcribe':
      return transcribe(args)
    case 'next':
      return next(args)
    case 'push':
      return push(args)
    case 'translate':
      return translate(args)
    case 'status':
      return status(args)
    case 'render':
      return renderCommand(args)
    case 'live':
      return live(args)
    case 'levels':
      return levels(args)
    case 'stop':
      return stop(args)
    case 'list':
      return list()
    case 'voices':
      return voices(args)
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(`${USAGE}\n`)
      return command === undefined ? EXIT.USAGE : EXIT.OK
    default:
      throw new UsageError(`Unknown command: ${command}\n\n${USAGE}`)
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Error: ${message}\n`)
    if (error instanceof UsageError || error instanceof UnsupportedProviderError) {
      process.exitCode = EXIT.USAGE
    } else if (error instanceof MissingDependencyError) {
      process.exitCode = EXIT.MISSING_DEPENDENCY
    } else {
      process.exitCode = EXIT.RUNTIME
    }
  })
