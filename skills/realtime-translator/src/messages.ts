/** User-facing strings of the capture backends. */
const MESSAGES = {
  'main.captureUnsupported':
    'App audio capture on "{platform}" is not supported (macOS and Windows only). Use `live --stdin` or `transcribe` instead.',
  'main.windowsOnly': 'WASAPI process loopback is available on Windows only.',
  'main.loopbackMissing':
    'Windows capture needs the application-loopback addon. Run `node scripts/setup.mjs --install-windows-capture` in the skill directory.',

  'tap.needsVersion': 'Per-app audio capture requires macOS 14.4 or newer.',
  'tap.processGone':
    'The selected app is no longer known to Core Audio. Start audio in it and run `list` again.',
  'tap.permission':
    'Missing System Audio Recording permission. Open System Settings → Privacy & Security → Screen & System Audio Recording, enable it for the app that launched this command (your terminal or agent host), then try again.',
  'tap.genericExit': 'The audio capture helper stopped unexpectedly (code {code}){detail}.',
  'tap.unknownCode': 'unknown',
  'tap.helperMissing':
    'Missing the macOS audio helper ({path}). Run `node scripts/setup.mjs` in the skill directory and try again.',
  'tap.listTimeout': 'The app-listing helper did not respond.',
  'tap.stoppedBeforeStart': 'Stopped before capture began.',
  'tap.startTimeout':
    'The audio helper did not respond within 30 seconds. If macOS is asking for System Audio Recording permission, allow it and start again.',
  'tap.invalidData': 'The audio helper returned invalid data.',
  'tap.invalidHeader': 'The audio helper returned an invalid header.',
} as const

export type MessageKey = keyof typeof MESSAGES
export type MessageParams = Record<string, string | number>

/** Looks up `key`, filling `{name}` placeholders from `params`. */
export function t(key: MessageKey, params?: MessageParams): string {
  const template: string = MESSAGES[key]
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  )
}
