// End-to-end for cloud providers: the real bundle and real ffmpeg, against a local HTTP
// stand-in for each API, reached through its base URL. This checks our requests and how
// we read responses as documented, not that the real services behave as documented.
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const CLI = resolve('skills/realtime-translator/scripts/translator.cjs')

interface Seen {
  method?: string
  path: string
  headers: IncomingMessage['headers']
  body: Buffer
}

type Handler = (seen: Seen, res: ServerResponse) => void

let server: Server
let base: string
let seen: Seen[]
let handler: Handler
let root: string
let tone: string
let job: string

const json = (res: ServerResponse, value: unknown, status = 200): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
}

const pcmSamples = (count: number): Buffer => Buffer.from(new Int16Array(count).fill(500).buffer)

/** A valid WAV with an extra chunk before `data`, as real services can send. */
function wavWithExtraChunk(samples: number): Buffer {
  const pcm = pcmSamples(samples)
  const extra = Buffer.from('LIST\x04\x00\x00\x00abcd', 'latin1')
  const fmt = Buffer.alloc(24)
  fmt.write('fmt ', 0)
  fmt.writeUInt32LE(16, 4)
  fmt.writeUInt16LE(1, 8)
  fmt.writeUInt16LE(1, 10)
  fmt.writeUInt32LE(24_000, 12)
  fmt.writeUInt32LE(48_000, 16)
  fmt.writeUInt16LE(2, 20)
  fmt.writeUInt16LE(16, 22)
  const dataHeader = Buffer.alloc(8)
  dataHeader.write('data', 0)
  dataHeader.writeUInt32LE(pcm.length, 4)
  const body = Buffer.concat([Buffer.from('WAVE'), fmt, extra, dataHeader, pcm])
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0)
  riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}

const translateEcho = (body: string): Array<{ id: number; text: string }> => {
  const start = body.indexOf('segments')
  const ids = [...body.slice(start).matchAll(/\\?"id\\?":(\d+)/g)].map((m) => Number(m[1]))
  return ids.map((id) => ({ id, text: `dịch ${id}` }))
}

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const clean = { ...process.env }
  for (const key of [
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'GROQ_API_KEY',
    'OPENROUTER_API_KEY',
  ]) {
    delete clean[key]
  }
  return {
    ...clean,
    OPENAI_BASE_URL: `${base}/openai`,
    GEMINI_BASE_URL: `${base}/gemini`,
    GROQ_BASE_URL: `${base}/groq`,
    OPENROUTER_BASE_URL: `${base}/openrouter`,
    OLLAMA_BASE_URL: `${base}/ollama`,
    ANTHROPIC_BASE_URL: `${base}/anthropic`,
    ...extra,
  }
}

/** Async, so the in-process mock can answer while the CLI runs. */
function cli(args: string[], extra: Record<string, string> = {}, input?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: env(extra) })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.stdin.end(input)
    child.on('close', (code) => done({ code, stdout, stderr }))
  })
}

/** A job with two untranslated segments, built through the public protocol's files. */
function seedJob(target = 'vi'): void {
  mkdirSync(job, { recursive: true })
  writeFileSync(
    join(job, 'job.json'),
    JSON.stringify({
      mode: 'file',
      source: 'x',
      targetLanguage: target,
      sourceLanguage: 'en',
      finished: true,
    }),
  )
  writeFileSync(
    join(job, 'segments.jsonl'),
    '{"id":1,"startMs":0,"endMs":500,"text":"Hello."}\n{"id":2,"startMs":800,"endMs":1200,"text":"Bye."}\n',
  )
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'rtt-prov-'))
  tone = join(root, 'talk.wav')
  // Loud speech-like bursts split by silence, so the segmenter finds two utterances.
  const samples: number[] = []
  for (let burst = 0; burst < 2; burst++) {
    for (let i = 0; i < 12_000; i++) samples.push(i % 2 ? 8_000 : -8_000)
    for (let i = 0; i < 16_000; i++) samples.push(0)
  }
  const raw = join(root, 'talk.pcm')
  writeFileSync(raw, Buffer.from(new Int16Array(samples).buffer))
  const made = spawnSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    's16le',
    '-ar',
    '16000',
    '-ac',
    '1',
    '-i',
    raw,
    tone,
  ])
  if (made.status !== 0) throw new Error('ffmpeg is required for the e2e tests')

  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const entry: Seen = {
        method: req.method,
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      }
      seen.push(entry)
      handler(entry, res)
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise((done) => server.close(done))
  rmSync(root, { recursive: true, force: true })
})
beforeEach(() => {
  seen = []
  job = join(root, `job-${Math.random().toString(36).slice(2)}`)
  handler = (_seen, res) => json(res, { error: 'no handler' }, 500)
})
afterEach(() => {
  handler = (_seen, res) => json(res, {})
})

describe('translate', () => {
  it('openai: uses the Responses API with a bearer key', async () => {
    seedJob()
    handler = (req, res) =>
      json(res, {
        output: [
          { type: 'reasoning', content: [] },
          {
            type: 'message',
            content: [
              { type: 'output_text', text: JSON.stringify(translateEcho(req.body.toString())) },
            ],
          },
        ],
      })
    const run = await cli(['translate', '--job', job, '--provider', 'openai'], {
      OPENAI_API_KEY: 'sk-test',
    })
    expect(run.stderr).not.toContain('Error')
    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout)).toMatchObject({ translated: 2, remaining: 0 })

    expect(seen[0].path).toBe('/openai/responses')
    expect(seen[0].headers.authorization).toBe('Bearer sk-test')
    const body = JSON.parse(seen[0].body.toString())
    expect(body.model).toBe('gpt-6-luna')
    expect(body.instructions).toContain('"vi"')
  })

  it('gemini: uses Interactions, with the key in a header rather than the URL', async () => {
    seedJob('ja')
    handler = (req, res) =>
      json(res, {
        steps: [
          {
            type: 'model_output',
            content: [{ type: 'text', text: JSON.stringify(translateEcho(req.body.toString())) }],
          },
        ],
      })
    const run = await cli(['translate', '--job', job, '--provider', 'gemini'], {
      GOOGLE_API_KEY: 'g-test',
    })
    expect(run.code).toBe(0)
    expect(seen[0].path).toBe('/gemini/interactions')
    expect(seen[0].path).not.toContain('g-test')
    expect(seen[0].headers['x-goog-api-key']).toBe('g-test')
    expect(seen[0].headers['api-revision']).toBe('2026-05-20')
    const body = JSON.parse(seen[0].body.toString())
    expect(body.model).toBe('gemini-3.8-flash')
    expect(body.system_instruction).toContain('"ja"')
  })

  it('anthropic: goes through the SDK, defaulting to Opus with fallbacks on', async () => {
    seedJob()
    handler = (req, res) =>
      json(res, {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: JSON.stringify(translateEcho(req.body.toString())) }],
      })
    const run = await cli(['translate', '--job', job, '--provider', 'anthropic'], {
      ANTHROPIC_API_KEY: 'a-test',
    })
    expect(run.stderr).not.toContain('Error')
    expect(run.code).toBe(0)
    expect(seen[0].path).toMatch(/^\/anthropic\/v1\/messages/)
    expect(seen[0].headers.authorization).toBe('Bearer a-test')
    expect(seen[0].headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01')
    const body = JSON.parse(seen[0].body.toString())
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      fallbacks: 'default',
      output_config: { effort: 'low' },
    })
  })

  it('anthropic: leaves fallbacks off for a model without them, and honours --model', async () => {
    seedJob()
    handler = (req, res) =>
      json(res, {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-5-5',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: JSON.stringify(translateEcho(req.body.toString())) }],
      })
    const run = await cli(
      ['translate', '--job', job, '--provider', 'anthropic', '--model', 'claude-haiku-5-5'],
      { ANTHROPIC_API_KEY: 'a-test' },
    )
    expect(run.code).toBe(0)
    const body = JSON.parse(seen[0].body.toString())
    expect(body.model).toBe('claude-haiku-5-5')
    expect(body).not.toHaveProperty('fallbacks')
  })

  it('anthropic: a refusal keeps the segments pending instead of faking a result', async () => {
    seedJob()
    handler = (_req, res) =>
      json(res, {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        stop_reason: 'refusal',
        usage: { input_tokens: 1, output_tokens: 0 },
        content: [],
      })
    const run = await cli(['translate', '--job', job, '--provider', 'anthropic'], {
      ANTHROPIC_API_KEY: 'a-test',
    })
    expect(run.code).toBe(4)
    expect(run.stderr).toContain('declined')
    const status = await cli(['status', '--job', job])
    expect(JSON.parse(status.stdout).remaining).toBe(2)
  })

  it('openai-compatible: ollama needs a model but no key, and sends no auth header', async () => {
    seedJob()
    const missing = await cli(['translate', '--job', job, '--provider', 'ollama'])
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('--translate-model')

    handler = (req, res) =>
      json(res, {
        choices: [{ message: { content: JSON.stringify(translateEcho(req.body.toString())) } }],
      })
    const run = await cli(['translate', '--job', job, '--provider', 'ollama', '--model', 'llama3'])
    expect(run.code).toBe(0)
    expect(seen[0].path).toBe('/ollama/chat/completions')
    expect(seen[0].headers.authorization).toBeUndefined()
    expect(JSON.parse(seen[0].body.toString()).model).toBe('llama3')
  })

  it('batches, carrying earlier translations as context', async () => {
    seedJob()
    handler = (req, res) =>
      json(res, {
        choices: [{ message: { content: JSON.stringify(translateEcho(req.body.toString())) } }],
      })
    const run = await cli(
      ['translate', '--job', job, '--provider', 'groq', '--model', 'm', '--batch', '1'],
      { GROQ_API_KEY: 'q' },
    )
    expect(JSON.parse(run.stdout)).toMatchObject({ translated: 2, remaining: 0 })
    expect(seen).toHaveLength(2)
    const second = JSON.parse(JSON.parse(seen[1].body.toString()).messages[1].content)
    expect(second.context).toEqual([{ source: 'Hello.', translation: 'dịch 1' }])
  })

  it('retries a server error, then succeeds', async () => {
    seedJob()
    let calls = 0
    handler = (req, res) => {
      calls++
      if (calls === 1) return json(res, { error: 'overloaded' }, 503)
      return json(res, {
        output: [
          {
            content: [
              { type: 'output_text', text: JSON.stringify(translateEcho(req.body.toString())) },
            ],
          },
        ],
      })
    }
    const run = await cli(['translate', '--job', job, '--provider', 'openai'], {
      OPENAI_API_KEY: 'k',
    })
    expect(run.code).toBe(0)
    expect(calls).toBe(2)
  })

  it('fails once with exit 3 on rejected credentials, without leaking the key', async () => {
    seedJob()
    handler = (_req, res) => json(res, { error: { message: 'bad key' } }, 401)
    const run = await cli(['translate', '--job', job, '--provider', 'openai'], {
      OPENAI_API_KEY: 'sk-secret-value',
    })
    expect(run.code).toBe(3)
    expect(run.stderr).toContain('rejected the credentials')
    expect(run.stderr + run.stdout).not.toContain('sk-secret-value')
    expect(seen).toHaveLength(1)
  })

  it('treats a Gemini invalid-key 400 as a credentials failure, without retrying', async () => {
    seedJob()
    handler = (_req, res) =>
      json(res, [{ error: { code: 400, details: [{ reason: 'API_KEY_INVALID' }] } }], 400)
    const run = await cli(['translate', '--job', job, '--provider', 'gemini'], {
      GEMINI_API_KEY: 'g',
    })
    expect(run.code).toBe(3)
    expect(seen).toHaveLength(1)
  })

  it('says a valid key lacks the model, rather than blaming the credentials', async () => {
    seedJob()
    handler = (_req, res) =>
      json(res, { error: { message: 'no access to model', code: 'model_not_found' } }, 403)
    const run = await cli(['translate', '--job', job, '--provider', 'openai'], {
      OPENAI_API_KEY: 'k',
    })
    expect(run.code).toBe(3)
    expect(run.stderr).toContain('may not include this model')
    expect(run.stderr).not.toContain('rejected the credentials')
    expect(seen).toHaveLength(1)
  })

  it('refuses to render a job with nothing translated, instead of writing empty files', async () => {
    seedJob()
    const srt = join(root, 'empty.srt')
    const run = await cli(['render', '--job', job, '--srt', srt, '--allow-partial'])
    expect(run.code).toBe(5)
    expect(run.stderr).toContain('nothing to render')
    expect(existsSync(srt)).toBe(false)
  })

  it('names the variable when a key is missing, before any request', async () => {
    seedJob()
    const run = await cli(['translate', '--job', job, '--provider', 'openai'])
    expect(run.code).toBe(3)
    expect(run.stderr).toContain('OPENAI_API_KEY')
    expect(seen).toHaveLength(0)
  })
})

describe('transcribe', () => {
  it('openai: segments locally, sends each utterance as multipart, keeps real timing', async () => {
    handler = (req, res) => {
      const count = seen.filter((s) => s.path.endsWith('/audio/transcriptions')).length
      expect(req.headers['content-type']).toContain('multipart/form-data')
      json(res, { text: `Line ${count}.` })
    }
    const run = await cli(['transcribe', tone, '--job', job, '--stt', 'openai', '-l', 'vi'], {
      OPENAI_API_KEY: 'k',
    })
    expect(run.stderr).toContain('recognized 2/2')
    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout).segments).toBe(2)

    expect(seen).toHaveLength(2)
    const form = seen[0].body.toString('latin1')
    expect(form).toContain('gpt-transcribe')
    expect(form).toContain('name="file"')
    expect(form).toContain('RIFF')

    const next = JSON.parse((await cli(['next', '--job', job])).stdout)
    expect(next.pending.map((s: { startMs: number }) => s.startMs)).toEqual([0, 1540]) // burst at 1750 ms, in the 1740 ms frame, less 200 ms pre-roll
  })

  it('gemini: sends inline base64 audio', async () => {
    handler = (_req, res) =>
      json(res, { steps: [{ content: [{ type: 'text', text: 'Xin chào.' }] }] })
    const run = await cli(['transcribe', tone, '--job', job, '--stt', 'gemini'], {
      GEMINI_API_KEY: 'g',
    })
    expect(run.code).toBe(0)
    const body = JSON.parse(seen[0].body.toString())
    expect(body.input[1]).toMatchObject({ type: 'audio', mime_type: 'audio/wav' })
    expect(Buffer.from(body.input[1].data, 'base64').subarray(0, 4).toString()).toBe('RIFF')
  })

  it('drops chunks the provider heard as silence', async () => {
    handler = (_req, res) => json(res, { text: '' })
    const run = await cli(['transcribe', tone, '--job', job, '--stt', 'groq'], {
      GROQ_API_KEY: 'q',
    })
    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout).segments).toBe(0)
    expect(seen[0].body.toString('latin1')).toContain('whisper-large-v3')
  })

  it('says plainly that anthropic has no speech recognition', async () => {
    const run = await cli(['transcribe', tone, '--job', job, '--stt', 'anthropic'], {
      ANTHROPIC_API_KEY: 'a',
    })
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('anthropic does not offer speech recognition')
    expect(seen).toHaveLength(0)
  })
})

describe('render with a cloud voice', () => {
  const translated = (): void => {
    seedJob()
    writeFileSync(
      join(job, 'translations.jsonl'),
      '{"id":1,"text":"Xin chào."}\n{"id":2,"text":"Tạm biệt."}\n',
    )
  }

  it('openai: asks for raw pcm and places it on the timeline', async () => {
    translated()
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      res.end(pcmSamples(2_400)) // 100 ms
    }
    const wav = join(root, 'openai.wav')
    const run = await cli(['render', '--job', job, '--audio', wav, '--tts', 'openai'], {
      OPENAI_API_KEY: 'k',
    })
    expect(run.code).toBe(0)
    expect(seen[0].path).toBe('/openai/audio/speech')
    expect(JSON.parse(seen[0].body.toString())).toMatchObject({
      model: 'gpt-4o-mini-tts',
      voice: 'marin',
      response_format: 'pcm',
      input: 'Xin chào.',
    })
    // Second line starts at 800 ms and lasts 100 ms: 900 ms at 24 kHz, 16-bit.
    expect(readFileSync(wav).length).toBe(44 + 900 * 24 * 2)
  })

  it('gemini: decodes the WAV it returns, whatever chunks precede the audio', async () => {
    translated()
    handler = (_req, res) =>
      json(res, {
        steps: [
          { type: 'thought', content: [] },
          {
            type: 'model_output',
            content: [
              {
                type: 'audio',
                mime_type: 'audio/wav',
                data: wavWithExtraChunk(2_400).toString('base64'),
              },
            ],
          },
        ],
      })
    const wav = join(root, 'gemini.wav')
    const run = await cli(
      ['render', '--job', job, '--audio', wav, '--tts', 'gemini', '--voice', 'Puck'],
      { GEMINI_API_KEY: 'g' },
    )
    expect(run.stderr).not.toContain('Error')
    expect(run.code).toBe(0)
    expect(JSON.parse(seen[0].body.toString())).toMatchObject({
      model: 'gemini-3.8-flash-tts',
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: 'Puck' }] },
    })
    expect(readFileSync(wav).length).toBe(44 + 900 * 24 * 2)
  })

  it('says plainly that anthropic has no voice', async () => {
    translated()
    const run = await cli(
      ['render', '--job', job, '--audio', join(root, 'x.wav'), '--tts', 'anthropic'],
      { ANTHROPIC_API_KEY: 'a' },
    )
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('anthropic does not offer speech output')
  })
})

describe('live with providers, nothing local', () => {
  it('runs the whole chain on stdin audio, and plays cloud speech', async () => {
    const shims = join(root, 'shims')
    mkdirSync(shims, { recursive: true })
    const played = join(root, 'played.log')
    rmSync(played, { force: true })
    for (const name of ['afplay', 'aplay']) {
      const path = join(shims, name)
      writeFileSync(
        path,
        `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(played)}, 'x')`,
      )
      chmodSync(path, 0o755)
    }

    handler = (req, res) => {
      if (req.path.endsWith('/audio/transcriptions')) return json(res, { text: 'Hello.' })
      if (req.path.endsWith('/audio/speech')) {
        res.writeHead(200)
        return void res.end(pcmSamples(240))
      }
      return json(res, {
        output: [
          {
            content: [
              { type: 'output_text', text: JSON.stringify(translateEcho(req.body.toString())) },
            ],
          },
        ],
      })
    }

    const raw = readFileSync(join(root, 'talk.pcm')).toString('latin1')
    const child = spawn(
      process.execPath,
      [
        CLI,
        'live',
        '--job',
        job,
        '--stdin',
        '--stt',
        'openai',
        '--translator',
        'openai',
        '--play',
        '--tts',
        'openai',
        '--drain',
        '5',
      ],
      {
        env: {
          ...env({ OPENAI_API_KEY: 'k' }),
          PATH: `${shims}${delimiter}${process.env.PATH}`,
        },
      },
    )
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stdin.end(Buffer.from(raw, 'latin1'))
    const code = await new Promise((done) => child.on('close', done))

    expect(code).toBe(0)
    const events = stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    expect(events.filter((e) => e.type === 'translation').map((e) => e.text)).toContain('dịch 1')
    expect(events.at(-1)).toMatchObject({ status: 'stopped', pending: 0 })
    expect(readFileSync(played, 'utf8').length).toBeGreaterThan(0)
  }, 30_000)

  it('stops at once when the provider rejects the key, instead of burning audio', async () => {
    handler = (_req, res) => json(res, { error: 'bad key' }, 401)
    const child = spawn(
      process.execPath,
      [CLI, 'live', '--job', job, '--stdin', '--stt', 'openai', '--drain', '5'],
      { env: env({ OPENAI_API_KEY: 'k' }) },
    )
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    // Keeps stdin open: only the failure can end this session.
    child.stdin.write(readFileSync(join(root, 'talk.pcm')))
    const code = await new Promise((done) => child.on('close', done))
    expect(code).toBe(3)
    expect(stderr).toContain('rejected the credentials')
  }, 30_000)
})
