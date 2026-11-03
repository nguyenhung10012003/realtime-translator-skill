import type { Readable } from 'node:stream'
import type { AudioFrame, AudioSource } from '../../types'
import { PcmFramer } from '../framing/PcmFramer'

/**
 * Reads raw 16 kHz mono 16-bit LE PCM from a stream. This is the escape hatch for any
 * capture the skill has no backend for, such as a microphone through ffmpeg.
 */
export class StdinSource implements AudioSource {
  private framer: PcmFramer | null = null
  private leftover = Buffer.alloc(0)

  constructor(
    private readonly input: Readable,
    private readonly onEnd: () => void,
  ) {}

  async start(onFrame: (frame: AudioFrame) => void): Promise<void> {
    const framer = new PcmFramer(onFrame)
    this.framer = framer
    this.input.on('data', (chunk: Buffer) => {
      if (this.framer !== framer) return
      const data = this.leftover.length ? Buffer.concat([this.leftover, chunk]) : chunk
      const usable = data.length - (data.length % 2)
      this.leftover = Buffer.from(data.subarray(usable))
      const copy = data.subarray(0, usable)
      framer.push(new Int16Array(copy.buffer.slice(copy.byteOffset, copy.byteOffset + usable)))
    })
    this.input.on('end', () => {
      if (this.framer !== framer) return
      framer.flush()
      this.onEnd()
    })
  }

  async stop(): Promise<void> {
    this.framer?.flush()
    this.framer = null
    // An open stdin would otherwise keep the process alive after a stop.
    this.input.destroy()
  }
}
