import WebSocket from 'ws'
import { SAMPLE_RATE } from '../audio/constants'
import { float32ToInt16, int16ToFloat32, resampleMono } from '../audio/resample/resamplePcm'
import { ProviderAuthError } from '../providers/http'
import { resolveProvider, type ResolvedProvider } from '../providers/registry'
import { primaryLanguage } from '../latency/levels'

export interface RealtimeEvents {
  /** Translated speech: 16-bit mono PCM at 24 kHz, from both providers. */
  onAudio(pcm: Int16Array): void
  onSourceText(delta: string): void
  onTranslatedText(delta: string): void
  onReconnecting(): void
  onReconnected(): void
  onWarning(message: string): void
  /** The session cannot continue. */
  onFatal(error: Error): void
}

/** What one server message means, in provider-neutral terms. */
interface Parsed {
  /** The server accepted the session. */
  ready?: boolean
  audio?: string
  source?: string
  translated?: string
  resumeHandle?: string
  goAway?: boolean
  closed?: boolean
  warning?: string
  fatal?: Error
  reply?: object
}

/** Each provider's wire format; the session handles the lifecycle around it. */
interface Adapter {
  url: string
  headers: Record<string, string>
  /** Sent when the socket opens, if the protocol starts with the client. */
  opening(resumeHandle: string | undefined): object | null
  parse(message: Record<string, any>): Parsed
  audioMessage(pcm16k: Int16Array): object
  finishMessage(): object
  /** Whether the server confirms a finish; otherwise the session waits for quiet. */
  confirmsFinish: boolean
}

const toWebSocketUrl = (url: string): string => url.replace(/^http/, 'ws')

const base64Pcm = (pcm: Int16Array): string =>
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64')

function openAiAdapter(provider: ResolvedProvider, language: string): Adapter {
  return {
    url: `${toWebSocketUrl(provider.baseUrl)}/realtime/translations?model=${encodeURIComponent(provider.model)}`,
    headers: { Authorization: `Bearer ${provider.apiKey}` },
    opening: () => null, // The server speaks first, with session.created.
    parse(message) {
      switch (message.type) {
        case 'session.created':
          return {
            reply: {
              type: 'session.update',
              session: {
                audio: {
                  input: { transcription: { model: 'gpt-realtime-whisper' } },
                  output: { language: primaryLanguage(language) },
                },
              },
            },
          }
        case 'session.updated':
          return { ready: true }
        case 'session.output_audio.delta':
          return { audio: message.delta }
        case 'session.input_transcript.delta':
          return { source: message.delta }
        case 'session.output_transcript.delta':
          return { translated: message.delta }
        case 'session.closed':
          return { closed: true }
        case 'error': {
          const code = String(message.error?.code ?? '')
          const text = String(message.error?.message ?? 'unknown error')
          // The docs say most errors leave the session usable; these never will.
          if (/invalid_api_key|model_not_found|insufficient_quota/.test(code)) {
            return { fatal: new ProviderAuthError(`openai refused the session: ${text}`) }
          }
          return { warning: `openai: ${text}` }
        }
        default:
          return {}
      }
    },
    audioMessage(pcm16k) {
      // This endpoint takes 24 kHz. Upsampling is safe; speech content stays below 8 kHz.
      const pcm24k = float32ToInt16(resampleMono(int16ToFloat32(pcm16k), SAMPLE_RATE, 24_000))
      return { type: 'session.input_audio_buffer.append', audio: base64Pcm(pcm24k) }
    },
    finishMessage: () => ({ type: 'session.close' }),
    confirmsFinish: true,
  }
}

function geminiAdapter(provider: ResolvedProvider, language: string): Adapter {
  const origin = new URL(provider.baseUrl).origin
  return {
    url: `${toWebSocketUrl(origin)}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`,
    headers: { 'x-goog-api-key': provider.apiKey ?? '' },
    opening: (resumeHandle) => ({
      setup: {
        model: `models/${provider.model}`,
        // Transcription sits beside generationConfig: the real API rejects it inside, though
        // the Live Translate docs show it there.
        generationConfig: {
          responseModalities: ['AUDIO'],
          translationConfig: { targetLanguageCode: language, echoTargetLanguage: true },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
      },
    }),
    parse(message) {
      const parsed: Parsed = {}
      if (message.setupComplete) parsed.ready = true
      const update = message.sessionResumptionUpdate
      if (update?.resumable && update.newHandle) parsed.resumeHandle = update.newHandle
      if (message.goAway) parsed.goAway = true
      const content = message.serverContent
      if (content) {
        parsed.ready = true
        if (content.inputTranscription?.text) parsed.source = content.inputTranscription.text
        if (content.outputTranscription?.text) parsed.translated = content.outputTranscription.text
        for (const part of content.modelTurn?.parts ?? []) {
          if (part.inlineData?.data) parsed.audio = part.inlineData.data
        }
      }
      return parsed
    },
    audioMessage: (pcm16k) => ({
      realtimeInput: { audio: { data: base64Pcm(pcm16k), mimeType: 'audio/pcm;rate=16000' } },
    }),
    finishMessage: () => ({ realtimeInput: { audioStreamEnd: true } }),
    confirmsFinish: false,
  }
}

/** Close codes meaning the request can never succeed, so retrying would only loop. */
const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([1007, 1008])
const READY_TIMEOUT_MS = 15_000
const MAX_RECONNECTS = 6
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 10_000
/** Send about 100 ms at a time, the chunk size both providers recommend. */
const CHUNK_SAMPLES = SAMPLE_RATE / 10
const FINISH_QUIET_MS = 2_500
const FINISH_MAX_MS = 20_000

const asError = (status: number, text: string, provider: string): Error =>
  status === 401 || status === 403 || status === 404
    ? new ProviderAuthError(
        `${provider} refused the realtime session (${status}); the key may lack this model. ${text}`,
      )
    : new Error(`${provider} realtime connection failed (${status}): ${text}`)

/**
 * One streaming translation session. Reconnects with backoff after a drop or `goAway`,
 * resuming where the provider supports it. Audio arriving during a gap is dropped,
 * because stale speech has no value live.
 */
export class RealtimeSession {
  private socket: WebSocket | null = null
  private state: 'new' | 'open' | 'reconnecting' | 'finishing' | 'closed' = 'new'
  private resumeHandle: string | undefined
  /** Reconnects since the server last proved the session healthy. */
  private attempts = 0
  private lastReason = 'connection closed'
  private pending: Int16Array[] = []
  private pendingSamples = 0
  private lastOutputAt = 0
  private serverClosed = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private ready: { resolve: () => void; reject: (error: Error) => void } | null = null

  private constructor(
    private readonly name: string,
    private readonly adapter: Adapter,
    private readonly events: RealtimeEvents,
  ) {}

  static create(
    providerName: string,
    options: { model?: string; language: string },
    events: RealtimeEvents,
  ): RealtimeSession {
    const provider = resolveProvider(providerName, 'realtime', options.model)
    const adapter =
      provider.info.kind === 'gemini'
        ? geminiAdapter(provider, options.language)
        : openAiAdapter(provider, options.language)
    return new RealtimeSession(providerName, adapter, events)
  }

  /** Resolves once the server accepts the session, so failures surface before capture. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.failReady(new Error(`${this.name} did not accept the session in time.`)),
        READY_TIMEOUT_MS,
      )
      this.ready = {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
      this.open()
    })
  }

  /** Queues 16 kHz mono PCM, sending in chunks. */
  send(pcm: Int16Array): void {
    if (this.state !== 'open' && this.state !== 'new') return
    this.pending.push(pcm)
    this.pendingSamples += pcm.length
    if (this.pendingSamples >= CHUNK_SAMPLES) this.flush()
  }

  private flush(): void {
    if (this.pendingSamples === 0) return
    const merged = new Int16Array(this.pendingSamples)
    let offset = 0
    for (const chunk of this.pending) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    this.pending = []
    this.pendingSamples = 0
    this.transmit(this.adapter.audioMessage(merged))
  }

  private transmit(message: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  /** Signals the end of input and waits for the translation still on its way. */
  async finish(): Promise<void> {
    if (this.state === 'closed') return
    this.flush()
    this.state = 'finishing'
    this.transmit(this.adapter.finishMessage())
    this.lastOutputAt = Date.now()
    const startedAt = Date.now()
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const quiet = Date.now() - this.lastOutputAt >= FINISH_QUIET_MS
        const done = this.adapter.confirmsFinish ? this.serverClosed : quiet
        if (done || !this.socket || Date.now() - startedAt >= FINISH_MAX_MS) {
          clearInterval(timer)
          resolve()
        }
      }, 100)
    })
  }

  close(): void {
    this.state = 'closed'
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    const socket = this.socket
    this.socket = null
    try {
      socket?.close()
    } catch {
      // Already going away.
    }
  }

  private open(): void {
    const socket = new WebSocket(this.adapter.url, { headers: this.adapter.headers })
    this.socket = socket
    const current = (): boolean => this.socket === socket && this.state !== 'closed'

    socket.on('open', () => {
      if (!current()) return
      const opening = this.adapter.opening(this.resumeHandle)
      if (opening) this.transmit(opening)
    })
    socket.on('message', (raw: WebSocket.RawData) => {
      if (current()) this.handleMessage(raw)
    })
    socket.on('unexpected-response', (_request, response) => {
      if (!current()) return
      const status = response.statusCode ?? 0
      let body = ''
      response.on('data', (chunk: Buffer) => (body += chunk.toString()))
      response.on('end', () => {
        const error = asError(status, body.replace(/\s+/g, ' ').slice(0, 300), this.name)
        if (error instanceof ProviderAuthError) this.fail(error)
        else this.handleDrop(error.message)
      })
    })
    socket.on('error', (error: Error) => {
      if (current()) this.handleDrop(error.message)
    })
    socket.on('close', (code: number, reason: Buffer) => {
      if (!current()) return
      const text = reason.toString()
      if (FATAL_CLOSE_CODES.has(code)) {
        const message = `${this.name} rejected the session (close code ${code}): ${text || 'no reason'}`
        this.fail(/api.?key/i.test(text) ? new ProviderAuthError(message) : new Error(message))
        return
      }
      if (this.state === 'finishing') this.serverClosed = true
      this.handleDrop(text || `socket closed (${code})`)
    })
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(raw.toString()) as Record<string, unknown>
    } catch {
      return
    }
    const parsed = this.adapter.parse(message)

    if (parsed.reply) this.transmit(parsed.reply)
    if (parsed.resumeHandle) this.resumeHandle = parsed.resumeHandle
    if (parsed.warning) this.events.onWarning(parsed.warning)
    if (parsed.fatal) {
      this.fail(parsed.fatal)
      return
    }
    if (parsed.ready) this.markReady()
    if (parsed.source) this.events.onSourceText(parsed.source)
    if (parsed.translated) {
      this.lastOutputAt = Date.now()
      this.events.onTranslatedText(parsed.translated)
    }
    if (parsed.audio) {
      this.lastOutputAt = Date.now()
      const bytes = Buffer.from(parsed.audio, 'base64')
      const even = bytes.byteLength - (bytes.byteLength % 2)
      this.events.onAudio(
        new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + even)),
      )
    }
    if (parsed.closed) this.serverClosed = true
    if (parsed.goAway) this.handleDrop('server asked to reconnect')
  }

  private markReady(): void {
    this.attempts = 0
    if (this.state === 'new') {
      this.state = 'open'
      this.ready?.resolve()
      this.ready = null
    } else if (this.state === 'reconnecting') {
      this.state = 'open'
      this.events.onReconnected()
    }
  }

  private handleDrop(reason: string): void {
    this.lastReason = reason
    const socket = this.socket
    this.socket = null
    try {
      socket?.close()
    } catch {
      // Already going away.
    }
    // A finish in progress has nothing left to send; `new` retries inside connect().
    if (this.state === 'finishing' || this.state === 'closed') return
    if (this.state === 'open') {
      this.state = 'reconnecting'
      this.events.onReconnecting()
    }
    this.attempts++
    if (this.attempts > MAX_RECONNECTS) {
      this.fail(
        new Error(
          `Could not reconnect to ${this.name} after ${MAX_RECONNECTS} attempts: ${this.lastReason}`,
        ),
      )
      return
    }
    const delay = Math.min(BASE_DELAY_MS * 2 ** (this.attempts - 1), MAX_DELAY_MS)
    this.reconnectTimer = setTimeout(() => {
      if (this.state !== 'closed') this.open()
    }, delay)
  }

  private failReady(error: Error): void {
    this.fail(error)
  }

  private fail(error: Error): void {
    if (this.state === 'closed') return
    this.close()
    if (this.ready) {
      this.ready.reject(error)
      this.ready = null
    } else {
      this.events.onFatal(error)
    }
  }
}
