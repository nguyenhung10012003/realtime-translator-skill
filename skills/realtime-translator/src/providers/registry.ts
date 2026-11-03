import { ProviderAuthError } from './http'

/** Which wire format a provider speaks. */
export type ProviderKind = 'openai' | 'openai-compatible' | 'gemini' | 'anthropic'

export interface ProviderInfo {
  kind: ProviderKind
  /** Environment variables holding the key, in order. Empty: no key is needed. */
  keyEnv: string[]
  baseUrl?: string
  /** Overrides `baseUrl`, for proxies and self-hosted gateways. */
  baseUrlEnv?: string
  /** Default model per capability. Absent means unsupported, unless `anyModel` lists it. */
  stt?: string
  translate?: string
  tts?: string
  /** Streaming speech-to-speech translation. */
  realtime?: string
  /** Capabilities that work but need an explicit model, because the catalog varies. */
  anyModel?: Array<'stt' | 'translate'>
}

/**
 * Model ids reflect each provider's documentation as of 2026-11. They change often, so
 * every one can be overridden on the command line; see references/providers.md.
 */
export const PROVIDERS: Record<string, ProviderInfo> = {
  openai: {
    kind: 'openai',
    keyEnv: ['OPENAI_API_KEY'],
    baseUrl: 'https://api.openai.com/v1',
    baseUrlEnv: 'OPENAI_BASE_URL',
    stt: 'gpt-transcribe',
    translate: 'gpt-6-luna',
    tts: 'gpt-4o-mini-tts',
    realtime: 'gpt-realtime-translate',
  },
  gemini: {
    kind: 'gemini',
    keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    baseUrlEnv: 'GEMINI_BASE_URL',
    stt: 'gemini-3.8-flash',
    translate: 'gemini-3.8-flash',
    tts: 'gemini-3.8-flash-tts',
    realtime: 'gemini-3.5-live-translate-preview',
  },
  // Credentials and base URL are resolved by the Anthropic SDK. The API has no audio
  // input or speech output, so this provider only translates.
  anthropic: { kind: 'anthropic', keyEnv: [], translate: 'claude-opus-5-5' },
  groq: {
    kind: 'openai-compatible',
    keyEnv: ['GROQ_API_KEY'],
    baseUrl: 'https://api.groq.com/openai/v1',
    baseUrlEnv: 'GROQ_BASE_URL',
    stt: 'whisper-large-v3',
    anyModel: ['translate'],
  },
  openrouter: {
    kind: 'openai-compatible',
    keyEnv: ['OPENROUTER_API_KEY'],
    baseUrl: 'https://openrouter.ai/api/v1',
    baseUrlEnv: 'OPENROUTER_BASE_URL',
    anyModel: ['translate'],
  },
  ollama: {
    kind: 'openai-compatible',
    keyEnv: [],
    baseUrl: 'http://localhost:11434/v1',
    baseUrlEnv: 'OLLAMA_BASE_URL',
    anyModel: ['translate'],
  },
}

export type Capability = 'stt' | 'translate' | 'tts' | 'realtime'

const CAPABILITY_NAME: Record<Capability, string> = {
  stt: 'speech recognition',
  translate: 'translation',
  tts: 'speech output',
  realtime: 'realtime translation',
}

/** Whether credentials for a provider are visible. Reports presence only, never values. */
export function hasCredentials(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (name === 'anthropic') {
    return Boolean(env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim())
  }
  const info = PROVIDERS[name]
  return info.keyEnv.some((key) => env[key]?.trim())
}

/** Providers with visible credentials that offer a capability. */
export function providersWith(
  capability: Capability,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return Object.keys(PROVIDERS).filter((name) => {
    const info = PROVIDERS[name]
    const offered =
      Boolean(info[capability]) ||
      ((capability === 'stt' || capability === 'translate') && info.anyModel?.includes(capability))
    return offered && hasCredentials(name, env)
  })
}

export interface ResolvedProvider {
  name: string
  info: ProviderInfo
  model: string
  baseUrl: string
  apiKey: string | null
}

/** Picks a provider's settings for one capability, or says exactly what is wrong. */
export function resolveProvider(
  name: string,
  capability: Capability,
  modelOverride: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProvider {
  const info = Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name] : undefined
  if (!info) {
    throw new UnsupportedProviderError(
      `Unknown provider "${name}". Available: ${Object.keys(PROVIDERS).join(', ')}.`,
    )
  }
  const flexible =
    (capability === 'stt' || capability === 'translate') && info.anyModel?.includes(capability)
  const model = modelOverride?.trim() || info[capability]
  if (!info[capability] && !flexible) {
    throw new UnsupportedProviderError(`${name} does not offer ${CAPABILITY_NAME[capability]}.`)
  }
  if (!model) {
    throw new UnsupportedProviderError(
      `${name} needs a model for ${CAPABILITY_NAME[capability]}; pass one with --${capability}-model.`,
    )
  }

  const baseUrl = (info.baseUrlEnv && env[info.baseUrlEnv]?.trim()) || info.baseUrl || ''
  const apiKey = info.keyEnv.map((key) => env[key]?.trim()).find(Boolean) ?? null
  if (info.keyEnv.length > 0 && !apiKey) {
    throw new ProviderAuthError(
      `${name} needs an API key. Ask the user to set ${info.keyEnv.join(' or ')} in their environment.`,
    )
  }
  return { name, info, model, baseUrl: baseUrl.replace(/\/+$/, ''), apiKey }
}

/** A bad provider choice, which is a usage problem rather than a runtime failure. */
export class UnsupportedProviderError extends Error {}

/** Extracts text from an Interactions API response: the last step's text blocks. */
export function geminiOutputText(response: GeminiInteraction): string {
  const steps = response.steps ?? []
  const last = steps[steps.length - 1]
  return (last?.content ?? [])
    .map((block) => block.text ?? '')
    .join('')
    .trim()
}

export interface GeminiInteraction {
  steps?: Array<{
    type?: string
    content?: Array<{ type?: string; text?: string; data?: string; mime_type?: string }>
  }>
}

/** Gemini's API revision the request and response shapes here were written against. */
export const GEMINI_API_REVISION = '2026-05-20'

export const geminiHeaders = (apiKey: string | null): Record<string, string> => ({
  'x-goog-api-key': apiKey ?? '',
  'Api-Revision': GEMINI_API_REVISION,
})
