// Node-side interface to the macOS Core Audio tap helper binary
// (native/macos/AudioTap.m → bin/audio-tap). The parsing
// and message mapping here is pure and unit-tested; process plumbing is not.

import { spawn } from 'node:child_process'
import type { AudioProcess } from '../../types'
import type { RawPcmFormat } from '../resample/resamplePcm'
import { t } from '../../messages'
import { bundledBinary, skillBinPath } from '../../runtimePaths'

const TAP_HELPER_NAME = 'audio-tap'

/** The stream description the helper prints as its first stdout line. */
export interface TapStreamHeader {
  sampleRate: number
  channels: number
  format: RawPcmFormat
}

/** Parses `AUDIO-TAP 1 rate=48000 channels=1 format=f32`; null when invalid. */
export function parseTapHeader(line: string): TapStreamHeader | null {
  const match = /^AUDIO-TAP 1 rate=(\d+) channels=(\d+) format=(f32|s16)$/.exec(line.trim())
  if (!match) return null
  const sampleRate = Number(match[1])
  const channels = Number(match[2])
  if (sampleRate < 8_000 || sampleRate > 192_000 || channels < 1 || channels > 8) return null
  return { sampleRate, channels, format: match[3] as RawPcmFormat }
}

/** Maps the helper's exit codes (see AudioTap.m) to user-facing messages. */
export function tapExitMessage(code: number | null, stderrTail: string): string {
  switch (code) {
    case 69:
      return t('tap.needsVersion')
    case 66:
      return t('tap.processGone')
    case 77:
      return t('tap.permission')
    default: {
      const line = stderrTail.trim().split('\n').at(-1) ?? ''
      return t('tap.genericExit', {
        code: code ?? t('tap.unknownCode'),
        detail: line ? `: ${line}` : '',
      })
    }
  }
}

/**
 * Parses the helper's `list` JSON into picker entries. Idle Apple system
 * daemons are dropped (useless targets); anything currently playing is kept
 * and marked with a speaker so the user can spot the right app instantly.
 */
export function parseProcessList(json: string): AudioProcess[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const result: AudioProcess[] = []
  for (const entry of parsed as Array<Record<string, unknown>>) {
    if (typeof entry?.pid !== 'number' || typeof entry?.name !== 'string') continue
    const audioActive = entry.audioActive === true
    if (entry.system === true && !audioActive) continue
    result.push({
      id: String(entry.pid),
      name: audioActive ? `🔊 ${entry.name}` : entry.name,
    })
  }
  return result
}

/**
 * Resolves the helper binary: `RTT_TAP_HELPER` wins, else `bin/` inside the
 * skill, where `scripts/setup.mjs` compiles it.
 */
export async function resolveTapHelperPath(): Promise<string> {
  const override = process.env.RTT_TAP_HELPER?.trim()
  if (override) return override
  const found = bundledBinary(TAP_HELPER_NAME)
  if (!found) {
    throw new Error(
      t('tap.helperMissing', { path: skillBinPath(TAP_HELPER_NAME) ?? TAP_HELPER_NAME }),
    )
  }
  return found
}

const LIST_TIMEOUT_MS = 5_000

/** Runs `audio-tap list` and parses the result. */
export async function listProcessesViaTapHelper(): Promise<AudioProcess[]> {
  const helperPath = await resolveTapHelperPath()
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, ['list'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(t('tap.listTimeout')))
    }, LIST_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(parseProcessList(stdout))
      else reject(new Error(tapExitMessage(code, stderr)))
    })
  })
}
