// End-to-end for latency levels: the real bundle with a stand-in recognizer for chunked
// levels, and local WebSocket stand-ins for the realtime providers, written to their
// docs. This proves our protocol handling, not how the real services behave.
import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'

const CLI = resolve('skills/realtime-translator/scripts/translator.cjs')

const KEYS = [
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
]

let root: string
let shims: string
let job: string
let http: Server
let wss: WebSocketServer
let base: string
let connections: Array<{
  url: string
  headers: Record<string, string | string[] | undefined>
  messages: any[]
}>
let behaviour: (socket: WebSocket, connection: (typeof connections)[number]) => void

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const clean = { ...process.env }
  for (const key of KEYS) delete clean[key]
  return {
    ...clean,
    PATH: `${shims}${delimiter}${process.env.PATH}`,
    RTT_WHISPER_MODEL: join(root, 'ggml-fake.bin'),
    RTT_FFPLAY_PATH: join(shims, 'fake-ffplay'),
    PLAYED: join(root, 'played.pcm'),
    OPENAI_BASE_URL: `${base}/v1`,
    GEMINI_BASE_URL: `${base}/v1beta`,
    ...extra,
  }
}

/** Loud bursts split by silence, as raw 16 kHz PCM. */
function speech(burstMs: number, silenceMs: number, bursts = 2): Buffer {
  const samples: number[] = []
  for (let burst = 0; burst < bursts; burst++) {
    for (let i = 0; i < burstMs * 16; i++) samples.push(i % 2 ? 8_000 : -8_000)
    for (let i = 0; i < silenceMs * 16; i++) samples.push(0)
  }
  return Buffer.from(new Int16Array(samples).buffer)
}

interface Result {
  code: number | null
  stderr: string
  events: any[]
}

function run(
  args: string[],
  input: Buffer | null,
  extra: Record<string, string> = {},
  holdOpenMs = 0,
) {
  const child = spawn(process.execPath, [CLI, ...args], { env: env(extra) })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  child.stdin.on('error', () => undefined)
  if (input && holdOpenMs > 0) {
    // Like a real capture, which keeps going after the first audio.
    child.stdin.write(input)
    setTimeout(() => child.stdin.end(), holdOpenMs)
  } else if (input) child.stdin.end(input)
  else child.stdin.end()
  return new Promise<Result>((done) => {
    child.on('close', (code) =>
      done({
        code,
        stderr,
        events: stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      }),
    )
  })
}

const pcmDelta = (samples = 2_400): string =>
  Buffer.from(new Int16Array(samples).fill(700).buffer).toString('base64')

const send = (socket: WebSocket, value: unknown): void => socket.send(JSON.stringify(value))

/** Answers as OpenAI's translation socket does, per its docs. */
function openAiBehaviour(socket: WebSocket, connection: (typeof connections)[number]): void {
  send(socket, { type: 'session.created' })
  let appended = 0
  socket.on('message', () => {
    const message = connection.messages.at(-1)
    if (message.type === 'session.update') send(socket, { type: 'session.updated' })
    if (message.type === 'session.input_audio_buffer.append') {
      appended++
      if (appended === 3) {
        send(socket, { type: 'session.input_transcript.delta', delta: 'Hello there.' })
        send(socket, { type: 'session.output_transcript.delta', delta: 'Xin chào ' })
        send(socket, { type: 'session.output_audio.delta', delta: pcmDelta() })
        send(socket, { type: 'session.output_transcript.delta', delta: 'mọi người nhé.' })
      }
    }
    if (message.type === 'session.close') {
      send(socket, { type: 'session.output_audio.delta', delta: pcmDelta() })
      send(socket, { type: 'session.closed' })
    }
  })
}

/** Answers as Gemini Live does, per its docs. */
function geminiBehaviour(socket: WebSocket, connection: (typeof connections)[number]): void {
  let audio = 0
  socket.on('message', () => {
    const message = connection.messages.at(-1)
    if (message.setup) {
      send(socket, { setupComplete: {} })
      send(socket, { sessionResumptionUpdate: { resumable: true, newHandle: 'handle-1' } })
    }
    if (message.realtimeInput?.audio) {
      audio++
      if (audio === 3) {
        send(socket, {
          serverContent: {
            inputTranscription: { text: 'Hello there.' },
            outputTranscription: { text: 'Xin chào mọi người nhé.' },
            modelTurn: {
              parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcmDelta() } }],
            },
          },
        })
      }
    }
  })
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'rtt-latency-'))
  shims = join(root, 'shims')
  mkdirSync(shims)
  writeFileSync(join(root, 'ggml-fake.bin'), 'fake')

  const shim = (name: string, body: string): void => {
    const path = join(shims, name)
    writeFileSync(path, `#!${process.execPath}\n${body}`)
    chmodSync(path, 0o755)
  }
  shim(
    'whisper-cli',
    `const fs = require('fs')
     const args = process.argv.slice(2)
     if (args.includes('--help')) process.exit(0)
     const out = args[args.indexOf('--output-file') + 1]
     fs.writeFileSync(out + '.json', JSON.stringify({
       transcription: [{ offsets: { from: 0, to: 100 }, text: ' words' }],
     }))`,
  )
  shim(
    'fake-ffplay',
    `const fs = require('fs')
     if (process.argv[2] === '-version') process.exit(0)
     process.stdin.pipe(fs.createWriteStream(process.env.PLAYED))`,
  )

  http = createServer()
  wss = new WebSocketServer({ server: http })
  wss.on('connection', (socket, request) => {
    const connection = { url: request.url ?? '', headers: request.headers, messages: [] as any[] }
    connections.push(connection)
    socket.on('message', (raw) => connection.messages.push(JSON.parse(raw.toString())))
    behaviour(socket, connection)
  })
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
})
afterAll(async () => {
  for (const client of wss.clients) client.terminate()
  await new Promise((done) => http.close(done))
  rmSync(root, { recursive: true, force: true })
})
beforeEach(() => {
  connections = []
  job = join(root, `job-${Math.random().toString(36).slice(2)}`)
  rmSync(join(root, 'played.pcm'), { force: true })
})

describe('levels', () => {
  it('reports each level for this machine, without any key values', async () => {
    const { events, code } = await run(['levels', '-l', 'vi'], null, {
      OPENAI_API_KEY: 'secret-value',
    })
    expect(code).toBe(0)
    const levels = Object.fromEntries(events[0].levels.map((l: any) => [l.level, l]))
    expect(levels.careful.available).toBe(true)
    expect(levels.balanced.providers).toContain('openai')
    expect(levels.realtime.providers).toEqual(['openai'])
    expect(JSON.stringify(events)).not.toContain('secret-value')
  })

  it('explains what is missing with no keys', async () => {
    const { events } = await run(['levels'], null)
    const realtime = events[0].levels.find((l: any) => l.level === 'realtime')
    expect(realtime.available).toBe(false)
    expect(realtime.missing).toContain('key')
  })
})

describe('chunked levels', () => {
  const segmentCount = (result: Result): number =>
    result.events.filter((e) => e.type === 'segment').length

  it('cuts continuous speech sooner at faster levels', async () => {
    const fiveSeconds = speech(5_000, 0, 1)
    const fast = await run(
      ['live', '--job', job, '--stdin', '--latency', 'fast', '--translator-cmd', 'cat'],
      fiveSeconds,
    )
    expect(fast.code).toBe(0)
    expect(segmentCount(fast)).toBe(2) // 3 s limit

    const careful = await run(
      ['live', '--job', `${job}-c`, '--stdin', '--latency', 'careful', '--drain', '0.1'],
      fiveSeconds,
    )
    expect(careful.code).toBe(0)
    expect(segmentCount(careful)).toBe(1) // 12 s limit
  }, 30_000)

  it('splits on shorter pauses at faster levels', async () => {
    const shortPauses = speech(600, 350)
    const fast = await run(
      ['live', '--job', job, '--stdin', '--latency', 'fast', '--translator-cmd', 'cat'],
      shortPauses,
    )
    expect(segmentCount(fast)).toBe(2)

    const balanced = await run(
      ['live', '--job', `${job}-b`, '--stdin', '--latency', 'balanced', '--translator-cmd', 'cat'],
      shortPauses,
    )
    expect(segmentCount(balanced)).toBe(1)
  }, 30_000)

  it('refuses a provider level with nothing to translate', async () => {
    const result = await run(['live', '--job', job, '--stdin', '--latency', 'fast'], null)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('--translator')
  })

  it('rejects an unknown level', async () => {
    const result = await run(['live', '--job', job, '--stdin', '--latency', 'warp'], null)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('careful')
  })
})

describe('realtime level', () => {
  const realtimeArgs = (provider: string, ...rest: string[]): string[] => [
    'live',
    '--job',
    job,
    '--stdin',
    '-l',
    'vi',
    '--latency',
    'realtime',
    '--realtime-provider',
    provider,
    ...rest,
  ]

  it('openai: streams 24 kHz audio, plays output, and leaves a renderable job', async () => {
    behaviour = openAiBehaviour
    const wav = join(root, 'openai-rt.wav')
    const result = await run(
      realtimeArgs('openai', '--play', '--audio', wav),
      speech(800, 200, 1),
      { OPENAI_API_KEY: 'o-key' },
    )
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)

    const [connection] = connections
    expect(connection.url).toBe('/v1/realtime/translations?model=gpt-realtime-translate')
    expect(connection.headers.authorization).toBe('Bearer o-key')
    expect(connection.messages[0]).toEqual({
      type: 'session.update',
      session: {
        audio: {
          input: { transcription: { model: 'gpt-realtime-whisper' } },
          output: { language: 'vi' },
        },
      },
    })
    // 100 ms at 24 kHz is 2,400 samples: confirms the upsampling, not just the pass-through.
    const first = connection.messages.find((m) => m.type === 'session.input_audio_buffer.append')
    expect(Buffer.from(first.audio, 'base64').length).toBe(2_400 * 2)
    expect(connection.messages.at(-1)).toEqual({ type: 'session.close' })

    expect(result.events.some((e) => e.status === 'first_output')).toBe(true)
    expect(result.events.find((e) => e.type === 'translation')?.text).toBe(
      'Xin chào mọi người nhé.',
    )
    expect(readFileSync(join(root, 'played.pcm')).length).toBe(2_400 * 2 * 2)
    expect(readFileSync(wav).readUInt32LE(24)).toBe(24_000)
    expect(existsSync(join(job, 'realtime.pcm'))).toBe(false)

    const srt = join(root, 'openai-rt.srt')
    const rendered = await run(['render', '--job', job, '--srt', srt, '--track', 'both'], null)
    expect(rendered.code).toBe(0)
    expect(readFileSync(srt.replace('.srt', '.vi.srt'), 'utf8')).toContain(
      'Xin chào mọi người nhé.',
    )
    expect(readFileSync(srt.replace('.srt', '.source.srt'), 'utf8')).toContain('Hello there.')
  }, 30_000)

  it('gemini: sends the documented setup at 16 kHz, with the key in a header', async () => {
    behaviour = geminiBehaviour
    const result = await run(realtimeArgs('gemini'), speech(800, 200, 1), {
      GEMINI_API_KEY: 'g-key',
    })
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)

    const [connection] = connections
    expect(connection.url).toContain('BidiGenerateContent')
    expect(connection.url).not.toContain('g-key')
    expect(connection.headers['x-goog-api-key']).toBe('g-key')
    expect(connection.messages[0].setup).toMatchObject({
      model: 'models/gemini-3.5-live-translate-preview',
      generationConfig: {
        responseModalities: ['AUDIO'],
        translationConfig: { targetLanguageCode: 'vi', echoTargetLanguage: true },
      },
    })
    // The real API rejects these inside generationConfig, despite the docs showing them there.
    expect(connection.messages[0].setup.inputAudioTranscription).toEqual({})
    expect(connection.messages[0].setup.generationConfig).not.toHaveProperty(
      'inputAudioTranscription',
    )
    const first = connection.messages.find((m) => m.realtimeInput?.audio)
    expect(first.realtimeInput.audio.mimeType).toBe('audio/pcm;rate=16000')
    expect(Buffer.from(first.realtimeInput.audio.data, 'base64').length).toBe(1_600 * 2)
    expect(connection.messages.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } })
    expect(result.events.find((e) => e.type === 'translation')?.text).toContain('Xin chào')
  }, 30_000)

  it('gemini: resumes with the server handle after goAway', async () => {
    let first = true
    behaviour = (socket, connection) => {
      geminiBehaviour(socket, connection)
      if (first) {
        first = false
        socket.on('message', () => {
          if (connection.messages.at(-1).setup) {
            setTimeout(() => send(socket, { goAway: { timeLeft: '1s' } }), 100)
          }
        })
      }
    }
    const result = await run(
      realtimeArgs('gemini'),
      speech(1_000, 100, 1),
      { GEMINI_API_KEY: 'g' },
      1_500,
    )
    expect(result.code).toBe(0)
    expect(result.events.some((e) => e.status === 'reconnecting')).toBe(true)
    expect(connections.length).toBeGreaterThanOrEqual(2)
    expect(connections[1].messages[0].setup.sessionResumption).toEqual({ handle: 'handle-1' })
  }, 30_000)

  it('fails before capture when the server rejects the key', async () => {
    behaviour = (socket) => {
      socket.on('message', () => socket.close(1007, 'API key not valid.'))
    }
    const result = await run(realtimeArgs('gemini'), speech(500, 100, 1), { GEMINI_API_KEY: 'bad' })
    expect(result.code).toBe(3)
    expect(result.stderr).toContain('API key not valid')
    expect(connections).toHaveLength(1)
  }, 30_000)

  it('refuses a target OpenAI does not document, suggesting Gemini', async () => {
    const args = realtimeArgs('openai')
    args[args.indexOf('-l') + 1] = 'th'
    const result = await run(args, null, { OPENAI_API_KEY: 'k' })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('gemini')
    expect(connections).toHaveLength(0)
  })

  it('refuses flags that have no meaning for a streaming session', async () => {
    const result = await run([...realtimeArgs('openai'), '--translator', 'anthropic'], null, {
      OPENAI_API_KEY: 'k',
    })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('--translator')
  })

  it('needs a provider, and names the missing key', async () => {
    const noProvider = await run(['live', '--job', job, '--stdin', '--latency', 'realtime'], null)
    expect(noProvider.code).toBe(2)
    expect(noProvider.stderr).toContain('--realtime-provider')

    const noKey = await run(realtimeArgs('openai'), null)
    expect(noKey.code).toBe(3)
    expect(noKey.stderr).toContain('OPENAI_API_KEY')
  })
})
