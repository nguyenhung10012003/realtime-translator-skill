#!/usr/bin/env node
// Installs the skill where an agent will find it. See README.md.
//
//   node install.mjs --agent claude                 user scope, copy
//   node install.mjs --agent codex --project .      into a project
//   node install.mjs --agent all --link             symlink, tracks this checkout
//   node install.mjs --dest ~/some/skills           any other skills directory
//   node install.mjs --agent claude --force         replace an existing install
//   node install.mjs --agent claude --dry-run       show what would happen
import { cpSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const SKILL_NAME = 'realtime-translator'
const source = join(dirname(fileURLToPath(import.meta.url)), 'skills', SKILL_NAME)

/** Skills directory per agent, relative to the home or project directory. */
const AGENT_DIRS = {
  claude: '.claude/skills',
  codex: '.agents/skills',
  gemini: '.gemini/skills',
  cursor: '.cursor/skills',
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

let options
try {
  ;({ values: options } = parseArgs({
    options: {
      agent: { type: 'string' },
      project: { type: 'string' },
      dest: { type: 'string' },
      link: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }))
} catch (error) {
  fail(error.message)
}

const USAGE = `Usage: node install.mjs (--agent <${Object.keys(AGENT_DIRS).join('|')}|all> | --dest <dir>)
                        [--project <dir>] [--link] [--force] [--dry-run]`

if (options.help) {
  process.stdout.write(`${USAGE}\n`)
  process.exit(0)
}
if (Boolean(options.agent) === Boolean(options.dest)) fail(USAGE)

function destinations() {
  if (options.dest) return [resolve(options.dest, SKILL_NAME)]
  const base = options.project ? resolve(options.project) : homedir()
  const agents = options.agent === 'all' ? Object.keys(AGENT_DIRS) : [options.agent]
  return agents.map((agent) => {
    const dir = AGENT_DIRS[agent]
    if (!dir) fail(`Unknown agent "${agent}".\n${USAGE}`)
    return join(base, dir, SKILL_NAME)
  })
}

const exists = (path) => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

// bin/, models/, and node_modules/ are machine-specific; setup.mjs recreates them.
const copyFilter = (path) => {
  const parts = relative(source, path).split(sep)
  return !['bin', 'models', 'node_modules'].includes(parts[0]) && !parts.includes('.DS_Store')
}

if (!existsSync(join(source, 'SKILL.md'))) fail(`Skill not found at ${source}`)

const targets = destinations()
const blocked = targets.filter((target) => exists(target) && !options.force)
if (blocked.length > 0) {
  fail(`Already installed (use --force to replace):\n  ${blocked.join('\n  ')}`)
}

for (const target of targets) {
  if (options['dry-run']) {
    const verb = options.link ? 'link' : 'copy'
    process.stdout.write(`would ${verb} ${source} -> ${target}\n`)
    continue
  }
  mkdirSync(dirname(target), { recursive: true })
  if (exists(target)) rmSync(target, { recursive: true, force: true })
  if (options.link) {
    symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
  } else {
    cpSync(source, target, { recursive: true, filter: copyFilter })
  }
  process.stdout.write(`${options.link ? 'linked' : 'copied'} -> ${target}\n`)
}

if (!options['dry-run']) {
  process.stdout.write(`\nNext: node "${join(targets[0], 'scripts/setup.mjs')}"\n`)
}
