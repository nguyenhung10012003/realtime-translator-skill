import type { AudioProcess, Platform } from '../types'
import { listProcessesViaTapHelper } from './macos/tapHelper'
import { loadLoopback } from './sources/WindowsLoopbackSource'

/**
 * Lists candidate capture targets for live mode.
 *
 * - Windows: visible application windows via the loopback helper — a practical
 *   proxy for "apps you might want to capture" (capture is per process id).
 * - macOS: processes registered with Core Audio via the tap helper's `list`
 *   mode; apps currently playing audio are marked and sorted first.
 * - Elsewhere: [].
 */
export async function listAudioProcesses(platform: Platform): Promise<AudioProcess[]> {
  if (platform === 'darwin') return listProcessesViaTapHelper()
  if (platform !== 'win32') return []

  const { getActiveWindowProcessIds } = await loadLoopback()
  const windows = await getActiveWindowProcessIds()

  // One process can own several windows; keep the first non-empty title per id.
  const titleById = new Map<string, string>()
  for (const win of windows) {
    const current = titleById.get(win.processId)
    if (current === undefined || current === '') titleById.set(win.processId, win.title ?? '')
  }
  return [...titleById].map(([id, name]) => ({ id, name: name || `PID ${id}` }))
}
