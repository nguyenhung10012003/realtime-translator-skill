import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** One recognized stretch of speech, on the source audio's timeline. */
export interface Segment {
  id: number
  startMs: number
  endMs: number
  text: string
}

export interface Translation {
  id: number
  text: string
}

export interface JobInfo {
  mode: 'file' | 'live'
  source: string
  targetLanguage: string
  sourceLanguage: string | null
  /** Set once no further segments will arrive. */
  finished: boolean
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  const rows: T[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line) as T)
    } catch {
      // A reader can catch a line mid-append; the next read sees it whole.
    }
  }
  return rows
}

/**
 * A translation job on disk. Plain files are the whole protocol between the
 * recognizer and the agent translating, so any agent that can run a command can
 * take part, and a job survives the process that created it.
 */
export class JobStore {
  readonly dir: string

  constructor(dir: string) {
    this.dir = resolve(dir)
  }

  private path(name: string): string {
    return join(this.dir, name)
  }

  exists(): boolean {
    return existsSync(this.path('job.json'))
  }

  create(info: Omit<JobInfo, 'finished'>): void {
    mkdirSync(this.dir, { recursive: true })
    for (const name of ['segments.jsonl', 'translations.jsonl']) {
      rmSync(this.path(name), { force: true })
    }
    this.writeInfo({ ...info, finished: false })
  }

  info(): JobInfo {
    return JSON.parse(readFileSync(this.path('job.json'), 'utf8')) as JobInfo
  }

  private writeInfo(info: JobInfo): void {
    writeFileSync(this.path('job.json'), JSON.stringify(info, null, 2))
  }

  update(changes: Partial<JobInfo>): void {
    this.writeInfo({ ...this.info(), ...changes })
  }

  segments(): Segment[] {
    return readJsonl<Segment>(this.path('segments.jsonl'))
  }

  /** Latest translation per id, so an agent can correct an earlier one. */
  translations(): Map<number, string> {
    const rows = readJsonl<Translation>(this.path('translations.jsonl'))
    return new Map(rows.map((row) => [row.id, row.text]))
  }

  /** Appends a segment with the next id. */
  addSegment(segment: Omit<Segment, 'id'>, nextId: number): Segment {
    const full: Segment = { id: nextId, ...segment }
    appendFileSync(this.path('segments.jsonl'), `${JSON.stringify(full)}\n`)
    return full
  }

  /** Records translations; rejects ids the job doesn't have, and blank text. */
  addTranslations(items: Translation[]): void {
    const known = new Set(this.segments().map((segment) => segment.id))
    for (const item of items) {
      if (!known.has(item.id)) throw new Error(`Unknown segment id: ${item.id}`)
      if (typeof item.text !== 'string' || !item.text.trim()) {
        throw new Error(`Empty translation for segment ${item.id}`)
      }
    }
    const lines = items.map((item) => `${JSON.stringify({ id: item.id, text: item.text })}\n`)
    appendFileSync(this.path('translations.jsonl'), lines.join(''))
  }

  /** Segments still waiting for a translation, oldest first. */
  pending(limit = Infinity): Segment[] {
    const done = this.translations()
    return this.segments()
      .filter((segment) => !done.has(segment.id))
      .slice(0, limit)
  }

  pidFile(): string {
    return this.path('live.pid')
  }
}
