/** Resolves an external tool: an explicit override wins, else `PATH`. */
export function resolveToolPath(name: string, override?: string): string {
  return override?.trim() || name
}

export const ffmpegPath: string = resolveToolPath('ffmpeg', process.env.RTT_FFMPEG_PATH)

/** Turns a spawn failure into something actionable; a missing binary is the usual cause. */
export function describeSpawnError(tool: string, path: string, error: Error): Error {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return error
  return new Error(
    `${tool} was not found (tried "${path}"). Run \`node scripts/setup.mjs\` in the skill directory for install instructions.`,
  )
}
