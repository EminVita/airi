import type { Batch, Plan } from './session'

import { describe, expect, it } from 'vitest'

import { parsePlan, Session } from './session'

const now = 100_000
function createSession() {
  const session = new Session()
  session.start('live', { direction: 'Campus', details: 'Noodles in the dorm' }, now)
  return session
}
function plan(patch: Partial<Plan> = {}): Plan {
  return { action: 'continue', text: 'The teacher opened the door.', topic: 'Campus', checkpoint: 'The teacher is at the door.', segmentComplete: false, replyToIds: [], skipIds: [], allowed: true, ...patch }
}
function batch(id = '1', text = 'What happened next?'): Batch {
  return { sessionId: 'live', source: 'test', batchId: id, messages: [{ id, userId: 'viewer', nickname: 'Viewer', text, createdAt: now }] }
}
function prepare(session: Session, value = plan()) {
  const work = session.reserve(now)!
  expect(session.accepts(work, value, now)).toBe(true)
  session.preparedAudio(work, value, new Blob(['audio']), 100, 50)
}

describe('livestream session', () => {
  it('advances the story only when audio ends', () => {
    const session = createSession()
    prepare(session)
    expect(session.snapshot().checkpoint).toBe('')
    const clip = session.take(now)!
    session.began(clip, now + 150)
    expect(session.snapshot().checkpoint).toBe('')
    session.ended(clip, now + 4000)
    expect(session.snapshot().checkpoint).toBe('The teacher is at the door.')
    expect(session.snapshot().metrics.played).toBe(1)
    expect(session.snapshot().metrics.firstAudioMs).toBe(150)
  })

  it('keeps ready story audio while an audience replacement is preparing', () => {
    const session = createSession()
    prepare(session)
    const first = session.take(now)!
    prepare(session, plan({ text: 'The roommates hid the noodles.' }))
    session.receive(batch(), now)
    const key = session.snapshot().comments[0]!.key
    const replacement = session.reserve(now)!
    expect(replacement.replacement).toBe(true)
    expect(session.snapshot().ready).toBe('The roommates hid the noodles.')
    session.ended(first, now + 4000)
    const second = session.take(now)!
    expect(second.plan.text).toBe('The roommates hid the noodles.')
    const reply = plan({ action: 'reply', text: 'Yes, the teacher noticed!', replyToIds: [key] })
    expect(session.accepts(replacement, reply, now + 4100)).toBe(true)
    session.preparedAudio(replacement, reply, new Blob(['reply']), 200, 100)
    expect(session.take(now)).toBeUndefined()
    session.ended(second, now + 7000)
    const answer = session.take(now)!
    expect(answer.plan.text).toBe('Yes, the teacher noticed!')
    expect(session.snapshot().comments).toHaveLength(1)
    session.ended(answer, now + 9000)
    expect(session.snapshot().comments).toHaveLength(0)
  })

  it('replaces waiting audio without marking the discarded sentence as spoken', () => {
    const session = createSession()
    prepare(session)
    const first = session.take(now)!
    prepare(session, plan({ text: 'An unplayed sentence.' }))
    session.receive(batch(), now)
    const work = session.reserve(now)!
    const reply = plan({ action: 'reply', text: 'A short answer.', replyToIds: [session.snapshot().comments[0]!.key] })
    expect(session.accepts(work, reply, now)).toBe(true)
    session.preparedAudio(work, reply, new Blob(['reply']), 100, 50)
    expect(session.snapshot().metrics.discardedCharacters).toBe('An unplayed sentence.'.length)
    session.ended(first, now + 4000)
    expect(session.take(now)!.plan.text).toBe('A short answer.')
    expect(session.snapshot().history.map(item => item.text)).toEqual(['The teacher opened the door.'])
  })

  it('ignores late work after pause and resumes from the completed checkpoint', () => {
    const session = createSession()
    prepare(session)
    const clip = session.take(now)!
    const work = session.reserve(now)!
    session.pause()
    session.preparedAudio(work, plan(), new Blob(['late']), 100, 50)
    session.ended(clip, now + 4000)
    expect(session.snapshot().ready).toBe('')
    expect(session.snapshot().checkpoint).toBe('')
    expect(session.snapshot().metrics.played).toBe(0)
    session.resume()
    expect(session.reserve(now)?.context.playing).toBe('')
  })

  it('preserves a direction change when the previous sentence finishes', () => {
    const session = createSession()
    prepare(session)
    const clip = session.take(now)!
    const work = session.reserve(now)!
    session.redirect('Cafeteria')
    expect(session.owns(work)).toBe(false)
    session.ended(clip, now + 4000)
    expect(session.snapshot().topic).toBe('Cafeteria')
    expect(session.snapshot().mainlineCheckpoint).toBe('')
    expect(session.snapshot().history).toHaveLength(1)
  })

  it('rejects duplicates, stale messages, and another broadcast', () => {
    const session = createSession()
    session.receive(batch(), now)
    session.receive(batch(), now)
    session.receive(batch('2'), now)
    session.receive({ ...batch('3'), sessionId: 'old-live' }, now)
    session.receive(batch('4', 'An old comment'), now + 100_000)
    expect(session.snapshot().comments).toHaveLength(0)
    expect(session.snapshot().metrics.received).toBe(1)
  })

  it('bounds burst input and refuses invented comment IDs', () => {
    const session = createSession()
    for (let index = 0; index < 70; index++)
      session.receive(batch(String(index), `Question ${index}`), now)
    expect(session.snapshot().comments).toHaveLength(50)
    const work = session.reserve(now)!
    expect(work.comments).toHaveLength(20)
    expect(() => session.accepts(work, plan({ action: 'reply', replyToIds: ['invented'] }), now)).toThrow('unavailable comment')
  })

  it('pauses after three failures and rejects a late failure from a prior run', () => {
    const session = createSession()
    const stale = session.reserve(now)!
    session.stop()
    session.start('new-live', { direction: 'Campus', details: '' }, now)
    expect(session.failed(stale, 'Old failure')).toBe(false)
    expect(session.snapshot().error).toBe('')
    for (let index = 0; index < 3; index++)
      session.failed(session.reserve(now)!, 'Provider unavailable')
    expect(session.snapshot().phase).toBe('paused')
    expect(session.snapshot().error).toBe('Provider unavailable')
    expect(session.reserve(now)).toBeUndefined()
  })

  it('finishes a story beat after two audience replies', () => {
    const session = createSession()
    for (let index = 0; index < 2; index++) {
      session.receive(batch(String(index), `Question ${index}`), now)
      prepare(session, plan({ action: 'reply', replyToIds: [session.snapshot().comments[0]!.key] }))
      session.ended(session.take(now)!, now + 4000)
    }
    session.receive(batch('next', 'Another question'), now)
    const work = session.reserve(now)!
    expect(work.context.finishSegment).toBe(true)
    expect(work.comments).toEqual([])
    const continuation = plan({ segmentComplete: true })
    expect(session.accepts(work, continuation, now)).toBe(true)
    session.preparedAudio(work, continuation, new Blob(['audio']), 100, 50)
    session.ended(session.take(now)!, now + 8000)
    expect(session.reserve(now)?.context.finishSegment).toBe(false)
  })

  it('validates generated structure and rejects unsafe speech', () => {
    expect(parsePlan(`\`\`\`json\n${JSON.stringify(plan())}\n\`\`\``).text).toBe('The teacher opened the door.')
    expect(() => parsePlan('{"text":"missing fields"}')).toThrow('Invalid livestream plan')
    const session = createSession()
    expect(() => session.accepts(session.reserve(now)!, plan({ allowed: false }), now)).toThrow('content check')
  })

  it('reserves a story continuation while the second answer is still playing', () => {
    const session = createSession()
    session.receive(batch(), now)
    prepare(session, plan({ action: 'reply', replyToIds: [session.snapshot().comments[0]!.key] }))
    session.ended(session.take(now)!, now + 1000)
    session.receive(batch('2', 'A different question'), now)
    prepare(session, plan({ action: 'reply', segmentComplete: true, replyToIds: [session.snapshot().comments[0]!.key] }))
    session.take(now)
    session.receive(batch('3', 'Yet another question'), now)
    const work = session.reserve(now)!
    expect(work.context.finishSegment).toBe(true)
    expect(work.comments).toEqual([])
  })

  it('preserves the mainline bookmark across an audience topic and return', () => {
    const session = createSession()
    prepare(session)
    session.ended(session.take(now)!, now + 1000)
    session.receive(batch('cat', 'Tell us about cats'), now)
    prepare(session, plan({ action: 'expand', topic: 'Cats', checkpoint: 'The cat is hungry.', replyToIds: [session.snapshot().comments[0]!.key] }))
    session.ended(session.take(now)!, now + 2000)
    const work = session.reserve(now)!
    expect(work.context.topic).toBe('Cats')
    expect(work.context.mainlineCheckpoint).toBe('The teacher is at the door.')
    const returning = plan({ action: 'return', text: 'Back at the dorm, the teacher smiled.' })
    expect(session.accepts(work, returning, now)).toBe(true)
    session.preparedAudio(work, returning, new Blob(['return']), 100, 50)
    session.ended(session.take(now)!, now + 3000)
    expect(session.snapshot().topic).toBe('Campus')
  })

  it('discards an answer whose audience message expires before playback', () => {
    const session = createSession()
    session.receive(batch(), now)
    prepare(session, plan({ action: 'reply', replyToIds: [session.snapshot().comments[0]!.key] }))
    expect(session.take(now + 90_001)).toBeUndefined()
    expect(session.snapshot().ready).toBe('')
    expect(session.snapshot().metrics.played).toBe(0)
  })

  it('does not count late synthesis against a new broadcast', () => {
    const session = createSession()
    const work = session.reserve(now)!
    session.start('new', { direction: 'Campus', details: '' }, now)
    session.preparedAudio(work, plan(), new Blob(['late']), 100, 50)
    expect(session.snapshot().metrics.synthesizedCharacters).toBe(0)
    expect(session.snapshot().ready).toBe('')
  })

  it('does not answer repeated text again under a new message ID', () => {
    const session = createSession()
    session.receive(batch(), now)
    prepare(session, plan({ action: 'reply', replyToIds: [session.snapshot().comments[0]!.key] }))
    session.ended(session.take(now)!, now + 1000)
    session.receive(batch('new-id'), now + 2000)
    expect(session.snapshot().comments).toHaveLength(0)
  })
})
