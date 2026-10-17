import { describe, expect, it } from 'vitest'

import { readingDuration, rehearsalMarkdown } from './rehearsal'
import { Session } from './session'

describe('text rehearsal delivery', () => {
  it('paces complete sentences, preserves a displayed sentence on pause, and exports its original brief', () => {
    const session = new Session()
    session.start('text', { direction: '校园', details: '# 本场\n我是小林。', mode: 'text' }, 0)
    const work = session.reserve(0)!
    const text = '我端起泡面，刚想开吃就听见敲门声。'
    const plan = { action: 'continue' as const, text, topic: '校园', checkpoint: '门外传来敲门声。', segmentComplete: false, replyToIds: [], skipIds: [], allowed: true }
    expect(readingDuration(text)).toBeGreaterThan(5000)
    session.preparedOutput(work, plan, { kind: 'text', durationMs: readingDuration(text) }, 200, 0)
    const clip = session.take(200)!
    session.began(clip, 200)
    session.pause(1000)
    expect(session.snapshot(1000).checkpoint).toBe(plan.checkpoint)
    expect(session.snapshot(1000).transcript[0]?.completed).toBe(true)
    session.resume(101_000)
    expect(session.snapshot(102_000).elapsedMs).toBe(2000)
    session.stop(103_000)
    const exported = rehearsalMarkdown(session.snapshot(103_000))
    expect(exported).toContain('# 本场\n我是小林。')
    expect(exported).toContain(text)
    expect(exported).not.toContain('(Interrupted)')
    expect(session.snapshot(103_000).metrics.synthesizedCharacters).toBe(0)
  })

  it('rejects preparation and playback after the rehearsal limit and isolates a new session', () => {
    const session = new Session()
    const settings = { direction: '校园', details: '我叫小林。', mode: 'text' as const }
    session.start('first', settings, 0)
    const work = session.reserve(0)!
    const plan = { action: 'continue' as const, text: '我刚进宿舍。', topic: '校园', checkpoint: '进宿舍', segmentComplete: false, replyToIds: [], skipIds: [], allowed: true }
    session.preparedOutput(work, plan, { kind: 'text', durationMs: 3000 }, 0, 0)
    expect(session.due(1_800_000)).toBe(true)
    expect(session.take(1_800_000)).toBeUndefined()
    expect(session.reserve(1_800_000)).toBeUndefined()
    session.stop(1_800_000, true)
    expect(session.snapshot(1_800_000).completed).toBe(true)
    session.start('second', settings, 1_900_000)
    session.preparedOutput(work, plan, { kind: 'text', durationMs: 3000 }, 0, 0)
    expect(session.snapshot(1_900_000).transcript).toEqual([])
    expect(session.snapshot(1_900_000).ready).toBe('')
    expect(session.due(1_900_000)).toBe(false)
  })
})
