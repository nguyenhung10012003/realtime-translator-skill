import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pcm16ToWav } from '../export/wav'
import { findSkillRoot } from '../runtimePaths'

/** One recognized stretch of speech, in milliseconds from the start of the input. */
export interface Transcribed {
  startMs: number
  endMs: number
  text: string
}

export interface TranscribeResult {
  language: string | null
  segments: Transcribed[]
}

/** Thrown when a local prerequisite is missing, as opposed to a runtime failure. */
export class MissingDependencyError extends Error {}

const CLI_NAMES = ['whisper-cli', 'whisper-cpp']
const MODEL_PREFERENCE = ['small', 'base', 'medium', 'large', 'tiny']

/** Whisper's markers for non-speech, like `[BLANK_AUDIO]` or `(music)`. */
const NON_SPEECH = /^[\s]*(\[[^\]]*\]|\([^)]*\)|♪[^♪]*♪?|\*[^*]*\*)[\s]*$/

/** Parses whisper.cpp's `--output-json` file, dropping non-speech markers. */
export function parseWhisperJson(json: string): TranscribeResult {
  const parsed = JSON.parse(json) as {
    result?: { language?: string }
    transcription?: Array<{ offsets?: { from?: number; to?: number }; text?: string }>
  }
  const segments: Transcribed[] = []
  for (const item of parsed.transcription ?? []) {
    const text = (item.text ?? '').trim()
    if (!text || NON_SPEECH.test(text)) continue
    segments.push({ startMs: item.offsets?.from ?? 0, endMs: item.offsets?.to ?? 0, text })
  }
  return { language: parsed.result?.language ?? null, segments }
}

/** The whisper.cpp binary: `RTT_WHISPER_CLI`, else the first known name on PATH. */
export function findWhisperCli(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.RTT_WHISPER_CLI?.trim()
  if (override) return override
  return CLI_NAMES.find((name) => !spawnSync(name, ['--help'], { stdio: 'ignore' }).error) ?? null
}

/** Picks the preferred model from file names like `ggml-base.bin`. */
export function pickModelFile(names: string[]): string | null {
  const models = names.filter((name) => /^ggml-.*\.bin$/.test(name))
  for (const size of MODEL_PREFERENCE) {
    const match = models.find((name) => name.startsWith(`ggml-${size}`))
    if (match) return match
  }
  return models[0] ?? null
}

/** Directories searched for a model. */
export function modelDirs(): string[] {
  const root = findSkillRoot()
  return [
    ...(root ? [join(root, 'models')] : []),
    join(homedir(), '.cache', 'realtime-translator', 'models'),
  ]
}

/** The model to use: an explicit path, `RTT_WHISPER_MODEL`, else the best one installed. */
export function findWhisperModel(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const direct = explicit?.trim() || env.RTT_WHISPER_MODEL?.trim()
  if (direct) return direct
  for (const dir of modelDirs()) {
    if (!existsSync(dir)) continue
    const file = pickModelFile(readdirSync(dir))
    if (file) return join(dir, file)
  }
  return null
}

export interface Recognizer {
  transcribeFile(wavPath: string): Promise<TranscribeResult>
  transcribePcm(pcm: Int16Array, sampleRate: number): Promise<TranscribeResult>
}

/** Runs whisper.cpp once per input. Throws when the binary or model is missing. */
export function createWhisper(options: { language?: string; model?: string } = {}): Recognizer {
  const cli = findWhisperCli()
  if (!cli) {
    throw new MissingDependencyError(
      'whisper.cpp was not found. Run `node scripts/setup.mjs` for install instructions.',
    )
  }
  const model = findWhisperModel(options.model)
  if (!model) {
    throw new MissingDependencyError(
      'No whisper model found. Run `node scripts/setup.mjs --download-model base`.',
    )
  }
  if (!existsSync(model)) throw new MissingDependencyError(`Whisper model not found: ${model}`)

  const language = options.language ?? 'auto'

  const transcribeFile = async (wavPath: string): Promise<TranscribeResult> => {
    const dir = mkdtempSync(join(tmpdir(), 'rtt-stt-'))
    const base = join(dir, 'out')
    try {
      await runWhisper(cli, [
        '--model',
        model,
        '--file',
        wavPath,
        '--language',
        language,
        '--output-json',
        '--output-file',
        base,
        '--no-prints',
      ])
      return parseWhisperJson(readFileSync(`${base}.json`, 'utf8'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  return {
    transcribeFile,
    async transcribePcm(pcm, sampleRate) {
      const dir = mkdtempSync(join(tmpdir(), 'rtt-chunk-'))
      const wavPath = join(dir, 'chunk.wav')
      try {
        writeFileSync(wavPath, pcm16ToWav(pcm, sampleRate))
        return await transcribeFile(wavPath)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  }
}

function runWhisper(cli: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2_000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`whisper.cpp exited with code ${code}: ${stderr.trim()}`))
    })
  })
}
