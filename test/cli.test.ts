// End-to-end: spawns the committed bundle as an agent would, with real ffmpeg. The
// recognizer and speech engine are shims on PATH, so this needs no model and makes no
// sound. It proves the pipeline and protocol, not recognition or voice quality.
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const CLI = resolve('skills/realtime-translator/scripts/translator.cjs')
const SETUP = resolve('skills/realtime-translator/scripts/setup.mjs')
const INSTALL = resolve('install.mjs')

let root: string
let shims: string
let tone: string
let spokenLog: string
let model: string
let job: string

function shim(name: string, body: string): void {
  const path = join(shims, name)
  writeFileSync(path, `#!${process.execPath}\n${body}`)
  chmodSync(path, 0o755)
}

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: `${shims}${delimiter}${process.env.PATH}`,
  RTT_WHISPER_MODEL: model,
  SPOKEN_LOG: spokenLog,
  ...extra,
})

interface Run {
  code: number | null
  stdout: string
  stderr: string
}

function cli(
  args: string[],
  options: { input?: string; extra?: Record<string, string> } = {},
): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input: options.input,
    env: env(options.extra),
  })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

const json = (run: Run): any => JSON.parse(run.stdout)

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'rtt-e2e-'))
  shims = join(root, 'shims')
  mkdirSync(shims)
  tone = join(root, 'talk.wav')
  spokenLog = join(root, 'spoken.log')
  model = join(root, 'ggml-fake.bin')
  writeFileSync(model, 'fake')

  const made = spawnSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    tone,
  ])
  if (made.status !== 0) throw new Error('ffmpeg is required for the e2e tests')

  // Speaks whisper.cpp's CLI: reads --output-file, writes <file>.json.
  shim(
    'whisper-cli',
    `const fs = require('fs')
     const args = process.argv.slice(2)
     if (args.includes('--help')) process.exit(0)
     if (process.env.FAKE_WHISPER_FAIL) { console.error('model load failed'); process.exit(1) }
     const out = args[args.indexOf('--output-file') + 1]
     fs.writeFileSync(out + '.json', JSON.stringify({
       result: { language: 'en' },
       transcription: [
         { offsets: { from: 0, to: 400 }, text: ' Hello there.' },
         { offsets: { from: 400, to: 800 }, text: ' [BLANK_AUDIO]' },
         { offsets: { from: 800, to: 1000 }, text: ' Goodbye.' },
       ],
     }))`,
  )

  // Speaks macOS say: lists voices, writes a WAV with -o, otherwise logs what it "said".
  shim(
    'say',
    `const fs = require('fs')
     const { execFileSync } = require('child_process')
     const args = process.argv.slice(2)
     if (args[1] === '?') {
       console.log('Linh                vi_VN    # Xin chao')
       console.log('Samantha            en_US    # Hello')
       process.exit(0)
     }
     const text = fs.readFileSync(args[args.indexOf('-f') + 1], 'utf8')
     const o = args.indexOf('-o')
     if (o === -1) { fs.appendFileSync(process.env.SPOKEN_LOG, text + '\\n'); process.exit(0) }
     execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-y','-f','lavfi','-i',
       'sine=frequency=880:duration=0.2','-ar','24000','-ac','1', args[o + 1]])`,
  )
})
afterAll(() => rmSync(root, { recursive: true, force: true }))
beforeEach(() => {
  job = join(root, `job-${Math.random().toString(36).slice(2)}`)
  rmSync(spokenLog, { force: true })
})

describe('file translation, with the agent as translator', () => {
  const transcribe = (): Run => cli(['transcribe', tone, '--job', job, '-l', 'vi'])

  it('transcribes, hands out pending segments, accepts translations, and renders', () => {
    const started = transcribe()
    expect(started.code).toBe(0)
    expect(json(started)).toMatchObject({ sourceLanguage: 'en', targetLanguage: 'vi', segments: 2 })

    const batch = json(cli(['next', '--job', job, '--limit', '1']))
    expect(batch.pending).toEqual([{ id: 1, startMs: 0, endMs: 400, text: 'Hello there.' }])
    expect(batch.remaining).toBe(2)
    expect(batch.finished).toBe(true)

    const pushed = cli(['push', '--job', job], {
      input: JSON.stringify([{ id: 1, text: 'Xin chào.' }]),
    })
    expect(json(pushed)).toEqual({ accepted: 1, remaining: 1 })

    // The second batch carries context from what was already translated.
    const second = json(cli(['next', '--job', job]))
    expect(second.pending.map((s: { id: number }) => s.id)).toEqual([2])
    expect(second.context).toEqual([{ source: 'Hello there.', translation: 'Xin chào.' }])

    // Refuses to render a half-translated job by default.
    const srt = join(root, 'out', 'nested', 'talk.srt')
    const early = cli(['render', '--job', job, '--srt', srt])
    expect(early.code).toBe(5)
    expect(early.stderr).toContain('1 segments have no translation')
    expect(existsSync(srt)).toBe(false)

    cli(['push', '--job', job], { input: JSON.stringify([{ id: 2, text: 'Tạm biệt.' }]) })
    const wav = join(root, 'out', 'nested', 'talk.vi.wav')
    const rendered = cli(['render', '--job', job, '--srt', srt, '--audio', wav])
    expect(rendered.stderr).toContain('speech 2/2')
    expect(rendered.code).toBe(0)

    const { outputs } = json(rendered)
    expect(outputs.map((o: { path: string }) => o.path).sort()).toEqual(
      [wav, srt.replace('.srt', '.source.srt'), srt.replace('.srt', '.vi.srt')].sort(),
    )
    expect(readFileSync(srt.replace('.srt', '.vi.srt'), 'utf8')).toBe(
      '1\n00:00:00,000 --> 00:00:00,600\nXin chào.\n\n2\n00:00:00,800 --> 00:00:01,400\nTạm biệt.\n',
    )
    expect(readFileSync(srt.replace('.srt', '.source.srt'), 'utf8')).toContain('Hello there.')
    const header = readFileSync(wav)
    expect(header.subarray(0, 4).toString()).toBe('RIFF')
    expect(header.readUInt32LE(24)).toBe(24_000)
  })

  it('renders what exists when asked to, and reports what was left out', () => {
    transcribe()
    cli(['push', '--job', job], { input: JSON.stringify([{ id: 1, text: 'Xin chào.' }]) })
    const vtt = join(root, 'partial.vtt')
    const run = cli([
      'render',
      '--job',
      job,
      '--vtt',
      vtt,
      '--track',
      'translated',
      '--allow-partial',
    ])
    expect(run.code).toBe(0)
    expect(json(run).untranslated).toBe(1)
    expect(readFileSync(vtt, 'utf8')).toMatch(/^WEBVTT\n/)
  })

  it('rejects bad translations without recording them', () => {
    transcribe()
    const unknown = cli(['push', '--job', job], { input: '[{"id":99,"text":"x"}]' })
    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toContain('Unknown segment id: 99')
    expect(cli(['push', '--job', job], { input: 'not json' }).code).toBe(2)
    expect(json(cli(['status', '--job', job])).remaining).toBe(2)
  })

  it('reports missing dependencies distinctly from runtime failures', () => {
    const noModel = cli(['transcribe', tone, '--job', job], {
      extra: { RTT_WHISPER_MODEL: join(root, 'absent.bin') },
    })
    expect(noModel.code).toBe(3)
    expect(noModel.stderr).toContain('model not found')

    const noWhisper = cli(['transcribe', tone, '--job', job], {
      extra: { RTT_WHISPER_CLI: join(root, 'no-such-whisper') },
    })
    expect(noWhisper.code).toBe(4)

    const crash = cli(['transcribe', tone, '--job', job], { extra: { FAKE_WHISPER_FAIL: '1' } })
    expect(crash.code).toBe(4)
    expect(crash.stderr).toContain('model load failed')

    const badFfmpeg = cli(['transcribe', tone, '--job', job], {
      extra: { RTT_FFMPEG_PATH: join(root, 'no-such-ffmpeg') },
    })
    expect(badFfmpeg.code).toBe(4)
    expect(badFfmpeg.stderr).toContain('ffmpeg was not found')
  })

  it('rejects bad usage before doing any work', () => {
    expect(cli(['transcribe', join(root, 'nope.mp3'), '--job', job]).code).toBe(2)
    expect(cli(['transcribe', tone]).code).toBe(2)
    expect(cli(['next', '--job', join(root, 'no-job')]).code).toBe(2)
    expect(cli(['bogus']).code).toBe(2)
  })
})

describe('live translation', () => {
  /** Loud half-second bursts split by silence, as raw 16 kHz PCM. */
  const speechPcm = (): Buffer => {
    const samples: number[] = []
    for (let burst = 0; burst < 2; burst++) {
      for (let i = 0; i < 8_000; i++) samples.push(i % 2 ? 8_000 : -8_000)
      for (let i = 0; i < 16_000; i++) samples.push(0)
    }
    return Buffer.from(new Int16Array(samples).buffer)
  }

  interface LiveRun {
    done: Promise<{ code: number | null; events: any[]; stderr: string }>
    write(data: Buffer): void
    end(): void
    kill(): void
  }

  function startLive(args: string[]): LiveRun {
    const child = spawn(process.execPath, [CLI, 'live', '--job', job, ...args], { env: env() })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    const done = new Promise<{ code: number | null; events: any[]; stderr: string }>((res) => {
      child.on('close', (code) =>
        res({
          code,
          stderr,
          events: stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        }),
      )
    })
    return {
      done,
      write: (data) => void child.stdin.write(data),
      end: () => void child.stdin.end(),
      kill: () => void child.kill('SIGTERM'),
    }
  }

  const waitFor = async (check: () => boolean, ms = 10_000): Promise<void> => {
    const deadline = Date.now() + ms
    while (!check()) {
      if (Date.now() > deadline) throw new Error('timed out')
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  it('segments stdin audio, then speaks translations the agent pushes', async () => {
    const session = startLive(['--stdin', '-l', 'vi', '--play', '--drain', '10'])
    const segmentsFile = join(job, 'segments.jsonl')
    await waitFor(() => existsSync(join(job, 'job.json')))
    session.write(speechPcm())
    await waitFor(() => existsSync(segmentsFile))

    const batch = json(cli(['next', '--job', job, '--wait', '5']))
    expect(batch.pending[0].text).toBe('Hello there. Goodbye.')
    expect(batch.finished).toBe(false)
    expect(json(cli(['status', '--job', job])).running).toBe(true)

    cli(['push', '--job', job], {
      input: JSON.stringify(
        batch.pending.map((s: { id: number }) => ({ id: s.id, text: `dịch ${s.id}` })),
      ),
    })
    await waitFor(() => existsSync(spokenLog))
    expect(readFileSync(spokenLog, 'utf8')).toContain('dịch 1')

    session.end()
    // Answer whatever the second burst produced, so the drain ends promptly.
    await waitFor(() => json(cli(['status', '--job', job])).finished === true)
    const rest = json(cli(['next', '--job', job])).pending
    if (rest.length > 0) {
      cli(['push', '--job', job], {
        input: JSON.stringify(rest.map((s: { id: number }) => ({ id: s.id, text: 'hết' }))),
      })
    }

    const { code, events } = await session.done
    expect(code).toBe(0)
    expect(events.some((e) => e.type === 'translation' && e.text === 'dịch 1')).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'stopped', pending: 0 })
    expect(existsSync(join(job, 'live.pid'))).toBe(false)
  }, 40_000)

  it('runs unattended with a translator command, and stop ends the session', async () => {
    const session = startLive(['--stdin', '--translator-cmd', 'tr a-z A-Z', '--drain', '1'])
    await waitFor(() => existsSync(join(job, 'job.json')))
    session.write(speechPcm())
    await waitFor(() => json(cli(['status', '--job', job])).segments > 0)
    expect(json(cli(['stop', '--job', job])).stopped).toBe(true)

    const { code, events } = await session.done
    expect(code).toBe(0)
    expect(events.find((e) => e.type === 'translation')?.text).toBe('HELLO THERE. GOODBYE.')
    expect(json(cli(['stop', '--job', job]))).toEqual({ stopped: false, reason: 'not running' })
  }, 40_000)

  it('stops itself after --duration, leaving untranslated segments for later', async () => {
    const session = startLive(['--stdin', '--duration', '1', '--drain', '0.2'])
    await waitFor(() => existsSync(join(job, 'job.json')))
    session.write(speechPcm())
    const { code, events } = await session.done
    expect(code).toBe(0)
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'stopped' })
    expect(events.at(-1).pending).toBeGreaterThan(0)
    expect(json(cli(['status', '--job', job])).finished).toBe(true)
  }, 40_000)

  it.runIf(process.platform === 'darwin')(
    'captures an app through the helper protocol',
    async () => {
      const argsLog = join(root, 'helper-args.txt')
      shim(
        'fake-tap',
        `const fs = require('fs')
       fs.writeFileSync(${JSON.stringify(argsLog)}, process.argv.slice(2).join(' '))
       process.stdout.write('AUDIO-TAP 1 rate=48000 channels=1 format=f32\\n')
       const loud = Buffer.alloc(48000 * 4 / 50)
       for (let i = 0; i < loud.length; i += 4) loud.writeFloatLE(i % 8 ? 0.3 : -0.3, i)
       setInterval(() => process.stdout.write(loud), 20)
       process.on('SIGTERM', () => process.exit(0))`,
      )
      const run = spawnSync(
        process.execPath,
        [
          CLI,
          'live',
          '--job',
          job,
          '-p',
          '42',
          '--duration',
          '1',
          '--drain',
          '0.2',
          '--mute-source',
          '--play',
        ],
        { encoding: 'utf8', env: env({ RTT_TAP_HELPER: join(shims, 'fake-tap') }) },
      )
      expect(run.stderr).toBe('')
      expect(run.status).toBe(0)
      expect(readFileSync(argsLog, 'utf8')).toBe('tap 42 --muted')
      expect(json(cli(['status', '--job', job])).segments).toBeGreaterThan(0)
    },
    40_000,
  )
})

describe('setup', () => {
  it('reports capabilities as JSON and needs no API key', () => {
    const result = spawnSync(process.execPath, [SETUP, '--check', '--json'], {
      encoding: 'utf8',
      env: env(),
    })
    const report = JSON.parse(result.stdout)
    expect(report.ready).toBe(true)
    expect(report).not.toHaveProperty('apiKey')
    expect(report.whisper.detail).toBe('whisper-cli')
    expect(result.status).toBe(0)
  })

  it('reports not ready, with the fix, when the model is missing', () => {
    const noKeys = {
      OPENAI_API_KEY: '',
      GEMINI_API_KEY: '',
      GOOGLE_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      GROQ_API_KEY: '',
      OPENROUTER_API_KEY: '',
    }
    const result = spawnSync(process.execPath, [SETUP, '--check', '--json'], {
      encoding: 'utf8',
      env: env({ ...noKeys, RTT_WHISPER_MODEL: join(root, 'absent.bin') }),
    })
    expect(result.status).toBe(1)
    // A cloud speech provider's key makes the local model optional, without revealing it.
    const withKey = spawnSync(process.execPath, [SETUP, '--check', '--json'], {
      encoding: 'utf8',
      env: env({
        ...noKeys,
        RTT_WHISPER_MODEL: join(root, 'absent.bin'),
        OPENAI_API_KEY: 'secret',
      }),
    })
    expect(withKey.status).toBe(0)
    expect(withKey.stdout).not.toContain('secret')
    expect(JSON.parse(result.stdout).model.detail).toContain('--download-model')
  })
})

describe('install', () => {
  const install = (...args: string[]) =>
    spawnSync(process.execPath, [INSTALL, ...args], { encoding: 'utf8' })

  it('copies a self-contained skill that runs from its new location', () => {
    const dest = join(root, 'skills-copy')
    expect(install('--dest', dest).status).toBe(0)
    const installed = join(dest, 'realtime-translator')
    expect(existsSync(join(installed, 'SKILL.md'))).toBe(true)
    for (const name of ['bin', 'models']) expect(existsSync(join(installed, name))).toBe(false)
    expect(statSync(join(installed, 'scripts/translator.cjs')).size).toBeLessThan(3_000_000)

    const run = spawnSync(process.execPath, [join(installed, 'scripts/translator.cjs'), 'help'], {
      encoding: 'utf8',
      cwd: root,
    })
    expect(run.status).toBe(0)
  })

  it('refuses to overwrite without --force, and places agents in their own directories', () => {
    const project = join(root, 'project')
    expect(install('--agent', 'all', '--project', project).status).toBe(0)
    for (const path of ['.claude/skills', '.agents/skills', '.gemini/skills', '.cursor/skills']) {
      expect(existsSync(join(project, path, 'realtime-translator/SKILL.md'))).toBe(true)
    }
    const again = install('--agent', 'codex', '--project', project)
    expect(again.status).toBe(2)
    expect(again.stderr).toContain('--force')
    expect(install('--agent', 'codex', '--project', project, '--force').status).toBe(0)
  })
})
