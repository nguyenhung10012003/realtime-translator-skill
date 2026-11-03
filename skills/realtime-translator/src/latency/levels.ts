import type { SegmenterOptions } from '../audio/segmenter'

export const LATENCY_LEVELS = ['careful', 'balanced', 'fast', 'realtime'] as const
export type LatencyLevel = (typeof LATENCY_LEVELS)[number]

/**
 * How each chunked level cuts speech. Longer waits give the translator whole sentences;
 * shorter ones get text out sooner but split sentences, which costs accuracy.
 */
export const SEGMENTATION: Record<Exclude<LatencyLevel, 'realtime'>, SegmenterOptions> = {
  careful: { silenceMs: 800, maxUtteranceMs: 12_000 },
  balanced: { silenceMs: 500, maxUtteranceMs: 6_000 },
  fast: { silenceMs: 250, maxUtteranceMs: 3_000 },
}

/** Target languages OpenAI documents for Realtime Translation. */
const OPENAI_REALTIME_TARGETS = new Set([
  'es',
  'pt',
  'fr',
  'ja',
  'ru',
  'zh',
  'de',
  'ko',
  'hi',
  'id',
  'vi',
  'it',
  'en',
])

export const primaryLanguage = (language: string): string => language.split('-')[0].toLowerCase()

/** Whether a realtime provider can translate into `language`. */
export function realtimeSupports(provider: string, language: string): boolean {
  return provider !== 'openai' || OPENAI_REALTIME_TARGETS.has(primaryLanguage(language))
}

/** What the machine has, gathered by the caller so this logic stays pure. */
export interface LevelFacts {
  targetLanguage: string
  /** whisper.cpp and a model are installed. */
  localStt: boolean
  /** Providers with credentials that can recognize speech. */
  sttProviders: string[]
  /** Providers with credentials that can translate. */
  translators: string[]
  /** Providers with credentials that can stream speech to speech. */
  realtimeProviders: string[]
  /** ffplay exists, which streaming playback needs. */
  streamingPlayback: boolean
}

export interface LevelReport {
  level: LatencyLevel
  available: boolean
  /** Why not, when unavailable. */
  missing?: string
  /** How far behind the speaker the translation runs. */
  latency: string
  /** False when `latency` is an estimate rather than a measurement. */
  measured: boolean
  tradeoff: string
  /** Providers usable at this level, most capable choice left to the caller. */
  providers?: string[]
  /** A warning that doesn't block the level, such as no spoken output. */
  note?: string
}

/** Reports every level for this machine, so an agent can match one to the user's need. */
export function assessLevels(facts: LevelFacts): LevelReport[] {
  const hasStt = facts.localStt || facts.sttProviders.length > 0
  const sttMissing = 'speech recognition: install whisper.cpp and a model, or set a provider key'
  const chunkedMissing = !hasStt
    ? sttMissing
    : facts.translators.length === 0
      ? 'a translation provider key, or use --translator-cmd'
      : undefined
  const realtime = facts.realtimeProviders.filter((name) =>
    realtimeSupports(name, facts.targetLanguage),
  )

  return [
    {
      level: 'careful',
      available: hasStt,
      ...(hasStt ? {} : { missing: sttMissing }),
      latency: '5 to 30 s after a sentence ends, depending on how fast you take turns',
      measured: false,
      tradeoff:
        'Best wording and full context, because you translate. Uses your tokens throughout.',
    },
    {
      level: 'balanced',
      available: chunkedMissing === undefined,
      ...(chunkedMissing ? { missing: chunkedMissing } : {}),
      latency: 'about 4 to 5 s after a sentence ends',
      measured: true,
      tradeoff: 'Whole sentences with no agent in the loop. Bills the provider per line.',
      providers: facts.translators,
    },
    {
      level: 'fast',
      available: chunkedMissing === undefined,
      ...(chunkedMissing ? { missing: chunkedMissing } : {}),
      latency: 'about 3 to 5 s behind the speech, cutting within 3 s of speaking',
      measured: false,
      tradeoff: 'Sooner text, but cuts mid-sentence, which costs accuracy and sounds choppy.',
      providers: facts.translators,
    },
    {
      level: 'realtime',
      available: realtime.length > 0,
      ...(realtime.length > 0
        ? {}
        : {
            missing:
              facts.realtimeProviders.length > 0
                ? `no realtime provider here supports "${facts.targetLanguage}"; Gemini covers more languages`
                : 'an OpenAI or Gemini key with realtime model access',
          }),
      latency: 'continuous speech-to-speech; expected within a few seconds',
      measured: false,
      tradeoff:
        'Lowest delay and the provider’s natural voice. All audio goes to the provider, billed by the second, and you cannot review the wording.',
      providers: realtime,
      ...(facts.streamingPlayback ? {} : { note: 'ffplay not found, so --play is unavailable' }),
    },
  ]
}
