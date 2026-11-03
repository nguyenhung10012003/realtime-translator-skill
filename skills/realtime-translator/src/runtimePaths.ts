import { existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

const MAX_LEVELS_UP = 6

/**
 * Finds the skill directory by walking up from the running script to the nearest
 * `SKILL.md`. Works for the bundle (`scripts/translator.cjs`), `tsx src/cli/index.ts`,
 * and symlinked installs (the realpath lands back in the checkout). Returns null
 * when the code is embedded elsewhere — callers then fall back to `PATH`.
 */
export function findSkillRoot(entry: string | undefined = process.argv[1]): string | null {
  if (!entry) return null
  let dir: string
  try {
    dir = dirname(realpathSync(entry))
  } catch {
    return null
  }
  for (let level = 0; level < MAX_LEVELS_UP; level++) {
    if (existsSync(join(dir, 'SKILL.md'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/** Where `scripts/setup.mjs` places a binary; null outside a skill checkout. */
export function skillBinPath(name: string): string | null {
  const root = findSkillRoot()
  return root ? join(root, 'bin', name) : null
}

/** The path of a binary installed into the skill's `bin/`, if it is there. */
export function bundledBinary(name: string): string | null {
  const path = skillBinPath(name)
  return path && existsSync(path) ? path : null
}
