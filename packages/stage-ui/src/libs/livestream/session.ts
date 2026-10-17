import { array, boolean, integer, maxLength, minLength, minValue, number, object, picklist, pipe, safeParse, string } from 'valibot'

/** Collectors address the current broadcast. Replayed batches cannot affect a later broadcast. */
export const batchSchema = object({
  sessionId: pipe(string(), minLength(1), maxLength(100)),
  batchId: pipe(string(), minLength(1), maxLength(100)),
  source: pipe(string(), minLength(1), maxLength(100)),
  messages: pipe(array(object({
    id: pipe(string(), minLength(1), maxLength(100)),
    userId: pipe(string(), minLength(1), maxLength(100)),
    nickname: pipe(string(), maxLength(80)),
    text: pipe(string(), minLength(1), maxLength(500)),
    createdAt: pipe(number(), integer(), minValue(0)),
  })), maxLength(100)),
})

/** One natural sentence, plus a checkpoint committed after delivery. */
export const planSchema = object({
  action: picklist(['continue', 'reply', 'expand', 'return']),
  text: pipe(string(), minLength(1), maxLength(160)),
  topic: pipe(string(), minLength(1), maxLength(200)),
  checkpoint: pipe(string(), maxLength(1200)),
  segmentComplete: boolean(),
  replyToIds: pipe(array(string()), maxLength(2)),
  skipIds: pipe(array(string()), maxLength(20)),
  allowed: boolean(),
})

export type Batch = import('valibot').InferOutput<typeof batchSchema>
export type Plan = import('valibot').InferOutput<typeof planSchema>
export interface Settings { direction: string, details: string, mode: 'speech' | 'text' }
export type Comment = Batch['messages'][number] & { key: string, receivedAt: number }
export type Delivery = { kind: 'audio', audio: Blob } | { kind: 'text', durationMs: number }
export interface Prepared { id: string, revision: number, plan: Plan, delivery: Delivery }

/** The review log records actual output and accepted comments, never speculative sentences. */
export interface TranscriptEntry {
  id: string
  kind: 'host' | 'comment' | 'direction'
  elapsedMs: number
  text: string
  nickname: string
  action: Plan['action'] | null
  replies: { nickname: string, text: string }[]
  completed: boolean
}

/** Runtime-only state. Audio, promises, and cancellation remain outside snapshots. */
export interface Snapshot {
  sessionId: string
  phase: 'stopped' | 'running' | 'paused'
  settings: Settings
  topic: string
  checkpoint: string
  mainlineCheckpoint: string
  playing: string
  ready: string
  preparing: boolean
  comments: Comment[]
  history: { text: string, action: Plan['action'] }[]
  transcript: TranscriptEntry[]
  elapsedMs: number
  durationMs: number | null
  completed: boolean
  error: string
  metrics: {
    received: number
    played: number
    synthesizedCharacters: number
    discardedCharacters: number
    lastGenerationMs: number
    lastSynthesisMs: number
    firstAudioMs: number | null
    lastGapMs: number | null
    lastReplyWaitMs: number | null
  }
}

/** A reservation captures the spoken context and candidate IDs for one model request. */
export interface Reservation {
  sessionId: string
  id: number
  revision: number
  replacement: boolean
  commentVersion: number
  comments: Comment[]
  context: {
    settings: Settings
    topic: string
    checkpoint: string
    mainlineCheckpoint: string
    history: Snapshot['history']
    playing: string
    finishSegment: boolean
    replacement: boolean
    elapsedMs: number
    remainingMs: number | null
  }
}

/** Parses model JSON without accepting prose outside its optional code fence. */
export function parsePlan(text: string): Plan {
  const source = text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')
  const result = safeParse(planSchema, JSON.parse(source))
  if (!result.success)
    throw new Error('Invalid livestream plan')
  return result.output
}

/**
 * Owns broadcast policy without network or audio side effects.
 * One reservation can replace one waiting clip. The playing clip is never replaced.
 * Revisions invalidate preparation after pause, stop, or an operator direction change.
 */
export class Session {
  private revision = 0
  private sequence = 0
  private commentVersion = 0
  private evaluatedVersion = 0
  private pending = new Map<string, Comment>()
  private seen = new Map<string, number>()
  private reservation: Reservation | undefined
  private prepared: Prepared | undefined
  private active: Prepared | undefined
  private replies = 0
  private finishSegment = false
  private failures = 0
  private startedAt = 0
  private endedAt: number | undefined
  private elapsed = 0
  private resumedAt = 0
  private state: Snapshot = this.empty()

  private empty(): Snapshot {
    return {
      sessionId: '',
      phase: 'stopped',
      settings: { direction: '', details: '', mode: 'text' },
      topic: '',
      checkpoint: '',
      mainlineCheckpoint: '',
      playing: '',
      ready: '',
      preparing: false,
      comments: [],
      history: [],
      transcript: [],
      elapsedMs: 0,
      durationMs: null,
      completed: false,
      error: '',
      metrics: { received: 0, played: 0, synthesizedCharacters: 0, discardedCharacters: 0, lastGenerationMs: 0, lastSynthesisMs: 0, firstAudioMs: null, lastGapMs: null, lastReplyWaitMs: null },
    }
  }

  snapshot(now = Date.now()): Snapshot {
    return structuredClone({ ...this.state, elapsedMs: this.elapsedMs(now), comments: [...this.pending.values()], preparing: !!this.reservation })
  }

  private elapsedMs(now: number) {
    return this.elapsed + (this.state.phase === 'running' ? Math.max(0, now - this.resumedAt) : 0)
  }

  private record(entry: TranscriptEntry) {
    this.state.transcript.push(entry)
    // A bounded log retains a normal rehearsal while limiting collector bursts.
    this.state.transcript = this.state.transcript.slice(-5000)
  }

  due(now: number) {
    return this.state.durationMs !== null && this.elapsedMs(now) >= this.state.durationMs
  }

  start(sessionId: string, settings: Settings, now: number) {
    this.stop(now)
    this.state = this.empty()
    this.state.sessionId = sessionId
    this.state.settings = { ...settings }
    this.state.topic = settings.direction
    this.state.phase = 'running'
    this.startedAt = now
    this.elapsed = 0
    this.resumedAt = now
    this.state.durationMs = settings.mode === 'text' ? 30 * 60_000 : null
    this.endedAt = undefined
    this.failures = 0
    this.replies = 0
    this.finishSegment = false
  }

  private invalidate() {
    this.revision++
    this.reservation = undefined
    this.discardPrepared()
  }

  private discardPrepared() {
    if (this.prepared?.delivery.kind === 'audio')
      this.state.metrics.discardedCharacters += this.prepared.plan.text.length
    this.prepared = undefined
    this.state.ready = ''
  }

  pause(now = Date.now()) {
    if (this.state.phase !== 'running')
      return
    // Text appears as a complete sentence. Preserve it across pause, even during its reading interval.
    if (this.active?.delivery.kind === 'text')
      this.ended(this.active, now)
    this.elapsed = this.elapsedMs(now)
    this.invalidate()
    this.active = undefined
    this.state.playing = ''
    this.state.phase = 'paused'
    this.endedAt = undefined
  }

  resume(now = Date.now()) {
    if (this.state.phase !== 'paused')
      return
    this.state.phase = 'running'
    this.resumedAt = now
    this.state.error = ''
    this.failures = 0
  }

  stop(now = Date.now(), completed = false) {
    if (this.active?.delivery.kind === 'text')
      this.ended(this.active, now)
    this.elapsed = this.elapsedMs(now)
    this.invalidate()
    this.active = undefined
    this.pending.clear()
    this.seen.clear()
    this.commentVersion = 0
    this.evaluatedVersion = 0
    this.state.playing = ''
    this.state.phase = 'stopped'
    this.state.completed = completed
  }

  redirect(direction: string, now = Date.now()) {
    this.invalidate()
    this.state.settings.direction = direction
    this.state.topic = direction
    this.state.checkpoint = ''
    this.state.mainlineCheckpoint = ''
    this.replies = 0
    this.finishSegment = false
    this.record({ id: `direction:${this.revision}`, kind: 'direction', elapsedMs: this.elapsedMs(now), text: direction, nickname: '', action: null, replies: [], completed: true })
  }

  receive(batch: Batch, now: number) {
    if (this.state.phase !== 'running' || batch.sessionId !== this.state.sessionId)
      return
    this.prune(now)
    for (const message of batch.messages) {
      const text = message.text.trim()
      const key = JSON.stringify([batch.source, message.id])
      const repetition = JSON.stringify([batch.source, message.userId, text])
      if (!text || this.seen.has(key) || this.seen.has(repetition) || now - message.createdAt > 90_000 || message.createdAt > now + 30_000)
        continue
      this.seen.set(key, now)
      this.seen.set(repetition, now)
      this.pending.set(key, { ...message, text, key, receivedAt: now })
      this.commentVersion++
      this.state.metrics.received++
      this.record({ id: key, kind: 'comment', elapsedMs: this.elapsedMs(now), text, nickname: message.nickname, action: null, replies: [], completed: true })
    }
    // The newest candidates replace older unread messages during a burst.
    while (this.pending.size > 50)
      this.pending.delete(this.pending.keys().next().value!)
    while (this.seen.size > 1000)
      this.seen.delete(this.seen.keys().next().value!)
  }

  private prune(now: number) {
    for (const [key, value] of this.pending) {
      if (now - value.createdAt > 90_000)
        this.pending.delete(key)
    }
    for (const [key, time] of this.seen) {
      if (now - time > 120_000)
        this.seen.delete(key)
    }
  }

  reserve(now: number): Reservation | undefined {
    if (this.state.phase !== 'running' || this.reservation || this.due(now))
      return
    this.prune(now)
    const projected = this.active?.revision === this.revision ? this.active.plan : undefined
    const projectedReply = projected?.action === 'reply' || projected?.action === 'expand'
    // Preparation runs during playback. Reserve the story beat before a second answer finishes.
    const finishSegment = this.finishSegment || (projectedReply && this.replies >= 1 && (projected.action === 'reply' || !projected.segmentComplete))
    const replacement = !!this.prepared
    if (replacement && (finishSegment || this.prepared!.plan.replyToIds.length > 0 || this.commentVersion <= this.evaluatedVersion))
      return
    const reserved = new Set([...(this.active?.plan.replyToIds ?? []), ...(this.prepared?.plan.replyToIds ?? [])])
    const comments = finishSegment ? [] : [...this.pending.values()].filter(item => !reserved.has(item.key)).slice(-20)
    if (replacement && comments.length === 0)
      return
    const advancing = projected && projected.action !== 'reply'
    const topic = advancing ? projected.topic : this.state.topic
    this.reservation = {
      sessionId: this.state.sessionId,
      id: ++this.sequence,
      revision: this.revision,
      replacement,
      commentVersion: this.commentVersion,
      comments,
      context: {
        settings: { ...this.state.settings },
        topic,
        checkpoint: advancing ? projected.checkpoint : this.state.checkpoint,
        mainlineCheckpoint: advancing && topic === this.state.settings.direction ? projected.checkpoint : this.state.mainlineCheckpoint,
        history: [...this.state.history],
        playing: this.state.playing,
        finishSegment,
        replacement,
        elapsedMs: this.elapsedMs(now),
        remainingMs: this.state.durationMs === null ? null : Math.max(0, this.state.durationMs - this.elapsedMs(now)),
      },
    }
    return this.reservation
  }

  owns(work: Reservation) {
    return this.state.phase === 'running' && this.reservation === work && work.revision === this.revision
  }

  /** Selection cannot answer absent, expired, or already spoken messages. */
  accepts(work: Reservation, plan: Plan, now: number) {
    if (!this.owns(work))
      return false
    this.prune(now)
    const candidates = new Set(work.comments.map(item => item.key))
    if (!plan.allowed || !plan.text.trim())
      throw new Error('The livestream plan did not pass its content check')
    if (new Set(plan.replyToIds).size !== plan.replyToIds.length || plan.replyToIds.some(id => !candidates.has(id) || !this.pending.has(id)))
      throw new Error('The livestream plan selected an unavailable comment')
    if ((plan.action === 'reply' || plan.action === 'expand') && plan.replyToIds.length === 0)
      throw new Error('An audience response must identify its comment')
    if ((plan.action === 'continue' || plan.action === 'return') && plan.replyToIds.length > 0)
      throw new Error('A story continuation cannot select an audience comment')
    if ((plan.action === 'continue' || plan.action === 'reply') && plan.topic !== work.context.topic)
      throw new Error('A continuation or short reply must preserve the current topic')
    if (plan.action === 'return' && plan.topic !== work.context.settings.direction)
      throw new Error('A return must use the operator direction')
    if (work.context.finishSegment && plan.action !== 'continue' && plan.action !== 'return')
      throw new Error('The current story segment must finish before another audience response')
    for (const id of plan.skipIds) {
      if (candidates.has(id) && !plan.replyToIds.includes(id))
        this.pending.delete(id)
    }
    this.evaluatedVersion = work.commentVersion
    if (work.replacement && plan.replyToIds.length === 0) {
      this.reservation = undefined
      return false
    }
    return true
  }

  preparedOutput(work: Reservation, plan: Plan, delivery: Delivery, generationMs: number, synthesisMs: number) {
    if (work.sessionId !== this.state.sessionId)
      return
    if (delivery.kind === 'audio')
      this.state.metrics.synthesizedCharacters += plan.text.length
    if (!this.owns(work)) {
      if (delivery.kind === 'audio')
        this.state.metrics.discardedCharacters += plan.text.length
      return
    }
    this.discardPrepared()
    this.prepared = { id: `${this.state.sessionId}:${work.id}`, revision: work.revision, plan, delivery }
    this.state.ready = plan.text
    this.state.metrics.lastGenerationMs = generationMs
    this.state.metrics.lastSynthesisMs = synthesisMs
    this.reservation = undefined
    this.failures = 0
    this.state.error = ''
  }

  take(now: number): Prepared | undefined {
    if (this.state.phase !== 'running' || this.active || !this.prepared || this.due(now))
      return
    this.prune(now)
    if (this.prepared.plan.replyToIds.some(id => !this.pending.has(id))) {
      this.discardPrepared()
      return
    }
    this.active = this.prepared
    this.prepared = undefined
    this.state.ready = ''
    this.state.playing = this.active.plan.text
    return this.active
  }

  began(clip: Prepared, now: number) {
    if (this.active !== clip)
      return
    if (clip.delivery.kind === 'audio')
      this.state.metrics.firstAudioMs ??= now - this.startedAt
    this.state.metrics.lastGapMs = this.endedAt === undefined ? null : now - this.endedAt
    const arrivals = clip.plan.replyToIds.map(id => this.pending.get(id)?.receivedAt).filter((time): time is number => time !== undefined)
    if (arrivals.length)
      this.state.metrics.lastReplyWaitMs = now - Math.min(...arrivals)
    this.record({
      id: clip.id,
      kind: 'host',
      elapsedMs: this.elapsedMs(now),
      text: clip.plan.text,
      nickname: '',
      action: clip.plan.action,
      replies: clip.plan.replyToIds.flatMap((id) => {
        const comment = this.pending.get(id)
        return comment ? [{ nickname: comment.nickname, text: comment.text }] : []
      }),
      completed: false,
    })
  }

  ended(clip: Prepared, now: number) {
    if (this.active !== clip)
      return
    this.active = undefined
    this.state.playing = ''
    this.endedAt = now
    this.state.metrics.played++
    const entry = this.state.transcript.find(item => item.id === clip.id)
    if (entry)
      entry.completed = true
    this.state.history.push({ text: clip.plan.text, action: clip.plan.action })
    this.state.history = this.state.history.slice(-20)
    for (const id of clip.plan.replyToIds)
      this.pending.delete(id)
    // An operator redirect preserves the audible sentence, but rejects its old narrative checkpoint.
    if (clip.revision !== this.revision)
      return
    if (clip.plan.action === 'reply' || clip.plan.action === 'expand') {
      this.replies++
      this.finishSegment ||= this.replies >= 2
    }
    if (clip.plan.action === 'reply')
      return
    this.state.topic = clip.plan.action === 'return' ? this.state.settings.direction : clip.plan.topic
    this.state.checkpoint = clip.plan.checkpoint
    if (this.state.topic === this.state.settings.direction)
      this.state.mainlineCheckpoint = clip.plan.checkpoint
    if (clip.plan.segmentComplete) {
      this.replies = 0
      this.finishSegment = false
    }
  }

  failed(work: Reservation, message: string) {
    if (!this.owns(work))
      return false
    this.reservation = undefined
    this.state.error = message
    this.failures++
    if (this.failures >= 3)
      this.pause()
    return this.state.phase === 'running'
  }

  playbackFailed(message: string) {
    this.pause()
    this.state.error = message
  }
}
