import type { Batch } from './session'

import { nanoid } from 'nanoid/non-secure'

/** Emits through the same batch contract as a real collector. Stop cancels the next scheduled batch. */
export class MockComments {
  private timer: ReturnType<typeof setTimeout> | undefined
  private sequence = 0
  private seed: number
  private readonly identity = nanoid()

  constructor(private readonly sessionId: string, private readonly samples: readonly string[], seed = Date.now()) {
    this.seed = seed >>> 0
  }

  private random() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0
    return this.seed / 0x1_0000_0000
  }

  batch(now = Date.now()): Batch {
    const count = this.samples.length ? 1 + Math.floor(this.random() * 4) : 0
    return {
      sessionId: this.sessionId,
      batchId: `${this.identity}:${++this.sequence}`,
      source: 'mock',
      messages: Array.from({ length: count }, () => {
        const sample = Math.floor(this.random() * this.samples.length)
        const user = Math.floor(this.random() * 6) + 1
        return { id: `${this.identity}:${++this.sequence}`, userId: `viewer-${user}`, nickname: `#${user}`, text: this.samples[sample]!, createdAt: now }
      }),
    }
  }

  /** Only one schedule can run. The caller owns event delivery and stops this source when the broadcast pauses. */
  start(emit: (batch: Batch) => void) {
    this.stop()
    const schedule = () => {
      this.timer = setTimeout(() => {
        this.timer = undefined
        emit(this.batch())
        schedule()
      }, 3000 + Math.floor(this.random() * 9000))
    }
    schedule()
  }

  stop() {
    clearTimeout(this.timer)
    this.timer = undefined
  }
}
