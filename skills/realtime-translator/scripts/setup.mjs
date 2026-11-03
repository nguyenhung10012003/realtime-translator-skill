#!/usr/bin/env node
// Checks what this skill needs on this machine and sets up what it safely can.
//
//   node scripts/setup.mjs                          report; on macOS also build the capture helper
//   node scripts/setup.mjs --check                  report only, change nothing
//   node scripts/setup.mjs --json                   machine-readable report
//   node scripts/setup.mjs --download-model <size>  fetch a whisper model: tiny, base, small, medium
//   node scripts/setup.mjs --install-windows-capture
//
// Never installs system packages; it prints the command for the user to run instead.
// Exit code: 0 when file translation is ready, 1 otherwise.
import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { homedir, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MODEL_SIZES = { tiny: '75 MB', base: '142 MB', small: '466 MB', medium: '1.5 GB' }
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

let values
try {
  ;({ values } = parseArgs({
    options: {
      check: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'download-model': { type: 'string' },
      'install-windows-capture': { type: 'boolean', default: false },
    },
  }))
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exit(2)
}

const log = (line) => {
  if (!values.json) process.stdout.write(`${line}\n`)
}
const canRun = (command, args) =>
  !spawnSync(command, args, { stdio: 'ignore', shell: process.platform === 'win32' }).error

const INSTALL = {
  darwin: { ffmpeg: 'brew install ffmpeg', whisper: 'brew install whisper-cpp' },
  linux: {
    ffmpeg: 'sudo apt install ffmpeg (or your distro equivalent)',
    whisper: 'build whisper.cpp: https://github.com/ggml-org/whisper.cpp',
  },
  win32: {
    ffmpeg: 'winget install Gyan.FFmpeg',
    whisper: 'download whisper-cli from https://github.com/ggml-org/whisper.cpp/releases',
  },
}[process.platform] ?? { ffmpeg: 'install ffmpeg', whisper: 'install whisper.cpp' }

const modelsDir = join(skillRoot, 'models')
const helperPath = join(skillRoot, 'bin', 'audio-tap')

// --- actions ------------------------------------------------------------------------

if (values['download-model']) {
  const size = values['download-model']
  if (!MODEL_SIZES[size]) {
    process.stderr.write(`Unknown model "${size}". Use: ${Object.keys(MODEL_SIZES).join(', ')}\n`)
    process.exit(2)
  }
  mkdirSync(modelsDir, { recursive: true })
  const target = join(modelsDir, `ggml-${size}.bin`)
  if (existsSync(target)) {
    log(`Already downloaded: ${target}`)
  } else {
    log(`Downloading ggml-${size}.bin (${MODEL_SIZES[size]})...`)
    const partial = `${target}.partial`
    try {
      const response = await fetch(`${MODEL_URL}/ggml-${size}.bin`)
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
      renameSync(partial, target)
      log(`Saved ${target}`)
    } catch (error) {
      rmSync(partial, { force: true })
      process.stderr.write(`Download failed: ${error.message}\n`)
      process.exit(1)
    }
  }
}

if (process.platform === 'darwin' && !values.check && !existsSync(helperPath)) {
  if (canRun('clang', ['--version'])) {
    log('Building the macOS capture helper...')
    const build = spawnSync('bash', [join(skillRoot, 'native/macos/build.sh')], {
      stdio: values.json ? 'ignore' : 'inherit',
    })
    if (build.status !== 0) log('Helper build failed; app capture stays unavailable.')
  } else {
    log('clang not found. Run `xcode-select --install` to enable app capture.')
  }
}

if (values['install-windows-capture']) {
  if (process.platform !== 'win32') {
    log('--install-windows-capture only applies on Windows; skipped.')
  } else {
    const install = spawnSync(
      'npm',
      ['install', '--prefix', skillRoot, '--no-save', '--no-package-lock', 'application-loopback'],
      { stdio: values.json ? 'ignore' : 'inherit', shell: true },
    )
    if (install.status !== 0) log('Install failed; app capture stays unavailable.')
  }
}

// --- report -------------------------------------------------------------------------

function findModel() {
  const direct = process.env.RTT_WHISPER_MODEL?.trim()
  if (direct) return existsSync(direct) ? direct : null
  for (const dir of [modelsDir, join(homedir(), '.cache', 'realtime-translator', 'models')]) {
    if (!existsSync(dir)) continue
    const file = readdirSync(dir).find((name) => /^ggml-.*\.bin$/.test(name))
    if (file) return join(dir, file)
  }
  return null
}

function findWhisper() {
  const override = process.env.RTT_WHISPER_CLI?.trim()
  if (override) return canRun(override, ['--help']) ? override : null
  return ['whisper-cli', 'whisper-cpp'].find((name) => canRun(name, ['--help'])) ?? null
}

function appCapture() {
  if (process.platform === 'darwin') {
    if (!existsSync(helperPath)) {
      return { ok: false, detail: 'capture helper not built; run `node scripts/setup.mjs`' }
    }
    // Darwin 23.4 is macOS 14.4, the first release with Core Audio process taps.
    const [major, minor] = release().split('.').map(Number)
    return major > 23 || (major === 23 && minor >= 4)
      ? { ok: true, detail: 'needs System Audio Recording permission on first use' }
      : { ok: false, detail: 'requires macOS 14.4 or newer' }
  }
  if (process.platform === 'win32') {
    return existsSync(join(skillRoot, 'node_modules', 'application-loopback'))
      ? { ok: true, detail: 'requires Windows 10 build 19041 or newer' }
      : { ok: false, detail: 'run `node scripts/setup.mjs --install-windows-capture`' }
  }
  return { ok: false, detail: 'only macOS and Windows; use `live --stdin` here' }
}

function speech() {
  if (process.platform === 'darwin') return { ok: canRun('say', ['-v', '?']), detail: 'say' }
  if (process.platform === 'win32') return { ok: true, detail: 'Windows System.Speech' }
  return canRun('espeak-ng', ['--version'])
    ? { ok: true, detail: 'espeak-ng' }
    : { ok: false, detail: 'install espeak-ng to get spoken output' }
}

/** Which cloud providers have a key set. Reports names only, never values. */
function cloudProviders() {
  const keys = {
    openai: ['OPENAI_API_KEY'],
    gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    groq: ['GROQ_API_KEY'],
    openrouter: ['OPENROUTER_API_KEY'],
  }
  return Object.keys(keys).filter((name) => keys[name].some((key) => process.env[key]?.trim()))
}

const nodeMajor = Number(process.versions.node.split('.')[0])
const ffmpegCommand = process.env.RTT_FFMPEG_PATH?.trim() || 'ffmpeg'
const hasFfmpeg = canRun(ffmpegCommand, ['-version'])
const whisper = findWhisper()
const model = findModel()
const providers = cloudProviders()

const report = {
  node: { ok: nodeMajor >= 20, detail: `v${process.versions.node} (needs 20+)` },
  ffmpeg: { ok: hasFfmpeg, detail: hasFfmpeg ? ffmpegCommand : `install: ${INSTALL.ffmpeg}` },
  whisper: { ok: Boolean(whisper), detail: whisper ?? `install: ${INSTALL.whisper}` },
  model: {
    ok: Boolean(model),
    detail:
      model ?? 'run: node scripts/setup.mjs --download-model base (142 MB; small is more accurate)',
  },
  speech: speech(),
  appCapture: appCapture(),
  providers: {
    ok: providers.length > 0,
    detail: providers.length > 0 ? providers.join(', ') : 'no API keys set (optional)',
  },
}
// Anthropic has no speech recognition, so its key alone can't replace local whisper.
const cloudStt = providers.some((name) => name !== 'anthropic' && name !== 'openrouter')
const localStt = report.whisper.ok && report.model.ok
const ready = report.node.ok && report.ffmpeg.ok && (localStt || cloudStt)

if (values.json) {
  process.stdout.write(`${JSON.stringify({ ready, ...report })}\n`)
} else {
  for (const [name, { ok, detail }] of Object.entries(report)) {
    log(`${ok ? 'ok     ' : '-      '}  ${name.padEnd(13)} ${detail}`)
  }
  log(ready ? '\nReady to translate.' : '\nNOT ready: fix the missing items above.')
}
process.exit(ready ? 0 : 1)
