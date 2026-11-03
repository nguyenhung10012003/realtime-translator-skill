import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pcm16ToWav } from '../export/wav'
import { postJson, postWithRetry } from '../providers/http'
import {
  geminiHeaders,
  resolveProvider,
  type GeminiInteraction,
  type ResolvedProvider,
} from '../providers/registry'
import { MissingDependencyError } from '../stt/whisper'
import { TTS_SAMPLE_RATE, type Speaker } from './tts'

const DEFAULT_VOICE: Record<string, string> = { openai: 'marin', gemini: 'Kore' }

const asInt16 = (bytes: Buffer): Int16Array => {
  const even = bytes.byteLength - (bytes.byteLength % 2)
  return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + even))
}

/** Finds the samples in a WAV by walking its chunks, since headers vary in length. */
export function pcmFromWav(wav: Buffer): Int16Array {
  if (wav.subarray(0, 4).toString('latin1') !== 'RIFF') return asInt16(wav)
  let offset = 12
  while (offset + 8 <= wav.length) {
    const id = wav.subarray(offset, offset + 4).toString('latin1')
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'data') return asInt16(wav.subarray(offset + 8, offset + 8 + size))
    offset += 8 + size + (size % 2)
  }
  throw new Error('The speech response had no audio data.')
}

async function synthesizeOpenAi(
  provider: ResolvedProvider,
  voice: string,
  text: string,
): Promise<Int16Array> {
  const response = await postWithRetry(provider.name, `${provider.baseUrl}/audio/speech`, () => ({
    headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
    // pcm is headerless 24 kHz 16-bit mono, exactly what the pipeline uses.
    body: JSON.stringify({ model: provider.model, input: text, voice, response_format: 'pcm' }),
  }))
  return asInt16(Buffer.from(await response.arrayBuffer()))
}

async function synthesizeGemini(
  provider: ResolvedProvider,
  voice: string,
  text: string,
): Promise<Int16Array> {
  const response = await postJson<GeminiInteraction>(
    provider.name,
    `${provider.baseUrl}/interactions`,
    geminiHeaders(provider.apiKey),
    {
      model: provider.model,
      input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice }] },
    },
  )
  for (const step of response.steps ?? []) {
    for (const block of step.content ?? []) {
      if (block.type === 'audio' && block.data) {
        return pcmFromWav(Buffer.from(block.data, 'base64'))
      }
    }
  }
  throw new Error('gemini returned no audio.')
}

/** The command that plays a WAV file here, or null when there is none. */
function playerCommand(path: string): [string, string[]] | null {
  if (process.platform === 'darwin') return ['afplay', [path]]
  if (process.platform === 'win32') {
    return [
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `(New-Object Media.SoundPlayer '${path.replace(/'/g, "''")}').PlaySync()`,
      ],
    ]
  }
  if (!spawnSync('aplay', ['--version'], { stdio: 'ignore' }).error) {
    return ['aplay', ['-q', path]]
  }
  if (!spawnSync('ffplay', ['-version'], { stdio: 'ignore' }).error) {
    return ['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'error', path]]
  }
  return null
}

async function playPcm(pcm: Int16Array): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rtt-play-'))
  const path = join(dir, 'speech.wav')
  try {
    writeFileSync(path, pcm16ToWav(pcm, TTS_SAMPLE_RATE))
    const command = playerCommand(path)
    if (!command) {
      throw new MissingDependencyError('No audio player found. Install aplay or ffplay.')
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command[0], command[1], { stdio: 'ignore' })
      child.on('error', reject)
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`${command[0]} exited with code ${code}`)),
      )
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A speaker backed by a cloud voice. Output is 24 kHz mono, like the system speaker. */
export function createCloudSpeaker(options: {
  provider: string
  model?: string
  voice?: string
}): Speaker {
  const provider = resolveProvider(options.provider, 'tts', options.model)
  const voice = options.voice ?? DEFAULT_VOICE[options.provider] ?? ''
  const synthesize = (text: string): Promise<Int16Array> =>
    provider.info.kind === 'gemini'
      ? synthesizeGemini(provider, voice, text)
      : synthesizeOpenAi(provider, voice, text)

  return {
    voice,
    synthesize,
    speak: async (text) => playPcm(await synthesize(text)),
  }
}
