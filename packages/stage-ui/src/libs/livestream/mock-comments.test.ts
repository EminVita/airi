import { afterEach, describe, expect, it, vi } from 'vitest'

import { MockComments } from './mock-comments'

afterEach(() => vi.useRealTimers())

describe('mock comment events', () => {
  it('reproduces a seeded sequence with unique message IDs and the broadcast identity', () => {
    const samples = ['A question', 'A story', 'A follow-up']
    const first = new MockComments('live', samples, 42)
    const second = new MockComments('live', samples, 42)
    const batches = Array.from({ length: 10 }, () => first.batch(1000))
    const repeated = Array.from({ length: 10 }, () => second.batch(1000))
    expect(batches.map(batch => batch.messages.map(message => message.text))).toEqual(repeated.map(batch => batch.messages.map(message => message.text)))
    const messages = batches.flatMap(batch => batch.messages)
    expect(new Set(messages.map(message => message.id)).size).toBe(messages.length)
    expect(batches.every(batch => batch.sessionId === 'live')).toBe(true)
    expect(batches.every(batch => batch.messages.length >= 1 && batch.messages.length <= 4)).toBe(true)
    expect(repeated[0]!.messages[0]!.id).not.toBe(batches[0]!.messages[0]!.id)
  })

  it('stops scheduled events and prevents duplicate schedules', () => {
    vi.useFakeTimers()
    const source = new MockComments('live', ['Question'], 42)
    const emit = vi.fn()
    source.start(emit)
    source.start(emit)
    vi.advanceTimersByTime(12_000)
    expect(emit).toHaveBeenCalled()
    source.stop()
    const count = emit.mock.calls.length
    vi.advanceTimersByTime(60_000)
    expect(emit).toHaveBeenCalledTimes(count)
  })
})
