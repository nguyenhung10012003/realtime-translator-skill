import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeToPcm } from '../audio/ffmpegTools'
import { MissingDependencyError } from '../stt/whisper'

/** Sample rate of synthesized speech throughout the pipeline. */
export const TTS_SAMPLE_RATE = 24_000

export interface Voice {
  name: string
  locale: string
}

/** Parses `say -v '?'` lines: `Linh   vi_VN   # Xin chào!`. Names may contain spaces. */
export function parseSayVoices(output: string): Voice[] {
  const voices: Voice[] = []
  for (const line of output.split('\n')) {
    const match = /^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]+)\s+#/.exec(line)
    if (match) voices.push({ name: match[1].trim(), locale: match[2] })
  }
  return voices
}

/** BCP-47 target → the locale prefix voices use. Script subtags imply a region. */
export function localePrefix(language: string): string {
  const lower = language.toLowerCase().replace('-', '_')
  if (lower === 'zh_hans') return 'zh_cn'
  if (lower === 'zh_hant') return 'zh_tw'
  return lower
}

/** macOS novelty voices speak gibberish or sing, so never pick them by default. */
const NOVELTY = new Set([
  'Albert',
  'Bad News',
  'Bahh',
  'Bells',
  'Boing',
  'Bubbles',
  'Cellos',
  'Wobble',
  'Fred',
  'Good News',
  'Jester',
  'Junior',
  'Kathy',
  'Organ',
  'Ralph',
  'Superstar',
  'Trinoids',
  'Whisper',
  'Zarvox',
])

/** Picks a natural voice for `language`, preferring one without a variant suffix. */
export function chooseVoice(voices: Voice[], language: string): Voice | null {
  const prefix = localePrefix(language)
  const candidates = voices.filter((voice) => {
    const locale = voice.locale.toLowerCase()
    return (locale === prefix || locale.startsWith(`${prefix}_`)) && !NOVELTY.has(voice.name)
  })
  return candidates.find((voice) => !voice.name.includes('(')) ?? candidates[0] ?? null
}

export function listVoices(): Voice[] {
  if (process.platform === 'darwin') {
    const result = spawnSync('say', ['-v', '?'], { encoding: 'utf8' })
    return result.error ? [] : parseSayVoices(result.stdout)
  }
  if (process.platform === 'win32') {
    const result = powershell(
      'Add-Type -AssemblyName System.Speech;' +
        '(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ' +
        'ForEach-Object { $_.VoiceInfo.Name + "|" + $_.VoiceInfo.Culture.Name }',
    )
    return result
      .split('\n')
      .map((line) => line.trim().split('|'))
      .filter((parts) => parts.length === 2)
      .map(([name, locale]) => ({ name, locale: locale.replace('-', '_') }))
  }
  return []
}

function powershell(script: string): string {
  const result = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
  return result.error ? '' : result.stdout
}

/** Quotes a value for a single-quoted PowerShell string. */
const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`

export interface Speaker {
  /** The voice in use, for reporting. */
  voice: string
  /** Renders text to 24 kHz mono 16-bit PCM. */
  synthesize(text: string): Promise<Int16Array>
  /** Speaks text aloud, resolving when finished. */
  speak(text: string): Promise<void>
}

/** Builds the OS speech engine for `language`. Throws when no voice can speak it. */
export function createSpeaker(language: string, requestedVoice?: string): Speaker {
  const voice = resolveVoice(language, requestedVoice)

  /** Writes text to a temp file: no shell, and no text mistaken for a flag. */
  const withTextFile = async <T>(
    text: string,
    run: (textPath: string, dir: string) => Promise<T>,
  ): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'rtt-tts-'))
    const textPath = join(dir, 'text.txt')
    try {
      writeFileSync(textPath, text, 'utf8')
      return await run(textPath, dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  return {
    voice,
    synthesize: (text) =>
      withTextFile(text, async (textPath, dir) => {
        const out = join(dir, 'speech.wav')
        await runEngine(engineCommand({ voice, textPath, out }))
        return decodeToPcm(out, TTS_SAMPLE_RATE)
      }),
    speak: (text) =>
      withTextFile(text, (textPath) => runEngine(engineCommand({ voice, textPath }))),
  }
}

function resolveVoice(language: string, requested?: string): string {
  if (requested) return requested
  if (process.platform === 'linux') {
    if (spawnSync('espeak-ng', ['--version'], { stdio: 'ignore' }).error) {
      throw new MissingDependencyError(
        'No speech engine found. Install espeak-ng, or render without --audio.',
      )
    }
    return language.split('-')[0]
  }
  const voice = chooseVoice(listVoices(), language)
  if (!voice) {
    const where =
      process.platform === 'darwin'
        ? 'System Settings → Accessibility → Spoken Content → System Voice → Manage Voices'
        : 'Settings → Time & language → Speech'
    throw new MissingDependencyError(
      `No system voice speaks "${language}". Add one under ${where}, or pass --voice.`,
    )
  }
  return voice.name
}

function engineCommand(options: {
  voice: string
  textPath: string
  out?: string
}): [string, string[]] {
  const { voice, textPath, out } = options
  if (process.platform === 'darwin') {
    return [
      'say',
      ['-v', voice, '-f', textPath, ...(out ? ['-o', out, '--data-format=LEI16@24000'] : [])],
    ]
  }
  if (process.platform === 'win32') {
    const target = out ? `$s.SetOutputToWaveFile(${psQuote(out)});` : ''
    return [
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Add-Type -AssemblyName System.Speech;' +
          '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;' +
          `$s.SelectVoice(${psQuote(voice)});${target}` +
          `$s.Speak([IO.File]::ReadAllText(${psQuote(textPath)}));$s.Dispose()`,
      ],
    ]
  }
  return ['espeak-ng', ['-v', voice, '-f', textPath, ...(out ? ['-w', out] : [])]]
}

function runEngine([command, args]: [string, string[]]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-1_000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`))
    })
  })
}
