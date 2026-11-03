/** One finished subtitle line: what was said, and its translation. */
export interface Caption {
  startMs: number
  endMs: number
  source: string
  translation: string
}

const MAX_CHARS = 84
const MIN_SENTENCE_CHARS = 12
const MAX_SPAN_MS = 7_000
/** Sentence-final punctuation (Latin + CJK), allowing trailing quotes or brackets. */
const SENTENCE_END = /[.!?…。！？][)"'”’»\]]*\s*$/

/**
 * Groups streamed transcript fragments into subtitle lines. Fragments carry no timing
 * and no markers tying source to translation, so lines close on the translated text and
 * take whatever source text arrived by then. Pairing is therefore approximate, which
 * suits captions but is why this mode has no sentence-level guarantees.
 */
export class CaptionPairer {
  private source = ''
  private translation = ''
  private startMs: number | null = null
  private lastMs = 0

  addSource(delta: string, atMs: number): void {
    this.begin(atMs)
    this.source += delta
  }

  /** Adds translated text, returning a caption when this completes a line. */
  addTranslation(delta: string, atMs: number): Caption | null {
    this.begin(atMs)
    this.translation += delta
    const text = this.translation.trim()
    const sentenceDone = text.length >= MIN_SENTENCE_CHARS && SENTENCE_END.test(this.translation)
    const tooLong = text.length >= MAX_CHARS
    const tooOld = atMs - (this.startMs as number) >= MAX_SPAN_MS
    return sentenceDone || tooLong || tooOld ? this.close() : null
  }

  /** Flushes whatever is open. Source text with no translation yet is dropped. */
  finish(atMs: number): Caption | null {
    this.lastMs = Math.max(this.lastMs, atMs)
    return this.translation.trim() ? this.close() : null
  }

  private begin(atMs: number): void {
    if (this.startMs === null) this.startMs = atMs
    this.lastMs = Math.max(this.lastMs, atMs)
  }

  private close(): Caption {
    const translation = this.translation.trim()
    const caption: Caption = {
      startMs: this.startMs as number,
      endMs: this.lastMs,
      // With source transcription off or lagging, the line still needs a source field.
      source: this.source.trim() || translation,
      translation,
    }
    this.source = ''
    this.translation = ''
    this.startMs = null
    return caption
  }
}
