import type { Conversation, SpeechOutput, TurnRef } from '@proj-airi/core-agent'
import type { PlaybackGroup } from '@proj-airi/pipelines-audio'

import type { Prepared, Reservation } from '../libs/livestream/session'

import { defineInvokeHandler } from '@moeru/eventa'
import { errorMessageFrom } from '@moeru/std'
import { nanoid } from 'nanoid/non-secure'
import { safeParse } from 'valibot'
import { onScopeDispose, shallowRef, watch } from 'vue'

import { MockComments } from '../libs/livestream/mock-comments'
import { createPlannerProvider, plannerInstructions } from '../libs/livestream/prompt'
import { readingDuration } from '../libs/livestream/rehearsal'
import { batchSchema, parsePlan, Session } from '../libs/livestream/session'
import { commandSchema, getLivestreamContext, livestreamBatch, livestreamCommand, livestreamRequestSnapshot, livestreamSnapshot } from '../services/livestream'
import { useLLM } from '../stores/ai/chat-llm/llm'
import { useAiriCardStore } from '../stores/modules/airi-card'
import { useProviderStore } from '../stores/providers/provider'
import { useVoiceStore } from '../stores/voice'

/**
 * The mounted stage owns generation, synthesis, and playback. Controls only send typed events.
 * Detachment aborts all work. A paused or stopped revision cannot publish late audio.
 */
export function useLivestreamHost(openOutput: (turn: TurnRef, characterId: string) => Promise<SpeechOutput>) {
  const cards = useAiriCardStore()
  const providers = useProviderStore()
  const llm = useLLM()
  const voice = useVoiceStore()
  const context = getLivestreamContext()
  const session = new Session()
  const running = shallowRef(false)
  const speechRunning = shallowRef(false)
  let characterId = ''
  let disposed = false
  let commandRevision = 0
  let generation: AbortController | undefined
  let playing: { clip: Prepared, abort: AbortController, group?: PlaybackGroup, timer?: ReturnType<typeof setTimeout> } | undefined
  let clock: ReturnType<typeof setInterval> | undefined
  const outputs = new Map<string, SpeechOutput>()
  let retry: ReturnType<typeof setTimeout> | undefined
  let source: MockComments | undefined
  let mockEnabled = false

  function publish() {
    const state = session.snapshot()
    running.value = state.phase === 'running'
    speechRunning.value = running.value && state.settings.mode === 'speech'
    context.emit(livestreamSnapshot, { connected: !disposed, state, mockEnabled })
    if (state.phase !== 'running') {
      source?.stop()
      clearInterval(clock)
      clock = undefined
    }
  }

  function startClock() {
    clearInterval(clock)
    // Rehearsal time includes generation waits, excludes pauses, and stops even when a provider hangs.
    clock = setInterval(() => {
      if (session.due(Date.now()))
        void stop(true)
      else
        publish()
    }, 1000)
  }

  function stopPreparation() {
    generation?.abort('Livestream preparation cancelled')
    generation = undefined
    clearTimeout(retry)
    retry = undefined
    outputs.clear()
  }

  async function silence() {
    const current = playing
    current?.abort.abort('Livestream playback cancelled')
    clearTimeout(current?.timer)
    await current?.group?.stop({ fadeMs: 0 })
    if (playing === current)
      playing = undefined
  }

  async function pause() {
    commandRevision++
    session.pause()
    stopPreparation()
    source?.stop()
    publish()
    await silence()
  }

  async function stop(completed = false) {
    commandRevision++
    session.stop(Date.now(), completed)
    stopPreparation()
    source?.stop()
    source = undefined
    mockEnabled = false
    publish()
    await silence()
  }

  function startMock() {
    source?.start(batch => context.emit(livestreamBatch, batch))
  }

  async function prepare(work: Reservation, controller: AbortController) {
    const began = performance.now()
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)])
      const selection = cards.getModules(characterId).consciousness
      if (!selection.provider || !selection.model)
        throw new Error('Configure a chat provider and model before starting the livestream')
      const provider = createPlannerProvider(await providers.getChatProviderInstance(selection.provider), selection.provider)
      signal.throwIfAborted()
      const conversation: Conversation = { turns: [
        { id: 'livestream-rules', type: 'system', authority: 'system', content: [{ type: 'text', text: plannerInstructions }] },
        { id: 'livestream-state', type: 'user', content: [{ type: 'text', text: JSON.stringify({
          ...work.context,
          history: work.context.history.slice(-8),
          character: { name: cards.activeCard?.name, description: cards.activeCard?.description, personality: cards.activeCard?.personality },
          comments: work.comments.map(comment => ({ key: comment.key, nickname: comment.nickname, text: comment.text, ageMs: Date.now() - comment.receivedAt })),
        }) }] },
      ] }
      let text = ''
      await llm.stream(selection.model, provider, conversation, {
        supportsTools: false,
        abortSignal: signal,
        onStreamEvent: (event) => {
          if (event.type === 'text-delta')
            text += event.text
        },
      })
      signal.throwIfAborted()
      const plan = parsePlan(text)
      if (!session.accepts(work, plan, Date.now()))
        return
      const generationMs = performance.now() - began
      if (work.context.settings.mode === 'text') {
        session.preparedOutput(work, plan, { kind: 'text', durationMs: readingDuration(plan.text) }, generationMs, 0)
        return
      }
      const state = session.snapshot()
      const turn = { sessionId: state.sessionId, turnId: `${state.sessionId}:${work.id}` }
      const output = await openOutput(turn, characterId)
      if (!('synthesize' in output))
        throw new Error('Select a speech provider with sentence synthesis for the livestream')
      signal.throwIfAborted()
      const synthesisStart = performance.now()
      const audio = await output.synthesize({
        turnId: turn.turnId,
        streamId: turn.turnId,
        intentId: turn.turnId,
        segmentId: turn.turnId,
        sequence: work.id,
        text: plan.text,
        special: null,
        reason: 'hard',
        priority: 0,
        createdAt: Date.now(),
      }, signal)
      signal.throwIfAborted()
      if (!audio?.size)
        throw new Error('Speech synthesis returned no audio. Check the voice and mute setting')
      if (session.owns(work)) {
        outputs.clear()
        outputs.set(turn.turnId, output)
      }
      session.preparedOutput(work, plan, { kind: 'audio', audio }, generationMs, performance.now() - synthesisStart)
    }
    catch (error) {
      if (!controller.signal.aborted && session.failed(work, errorMessageFrom(error) ?? 'Livestream preparation failed')) {
        // Retry spacing bounds provider load. Three consecutive failures pause the session.
        retry = setTimeout(() => {
          retry = undefined
          pump()
        }, 2000)
      }
      else if (generation === controller && session.snapshot().phase === 'paused') {
        await silence()
      }
    }
    finally {
      if (generation === controller)
        generation = undefined
      publish()
      if (!disposed)
        pump()
    }
  }

  async function play(clip: Prepared) {
    if (clip.delivery.kind === 'text') {
      const current = { clip, abort: new AbortController(), timer: setTimeout(() => {
        if (playing !== current)
          return
        session.ended(clip, Date.now())
        playing = undefined
        pump()
      }, clip.delivery.durationMs) }
      playing = current
      session.began(clip, Date.now())
      publish()
      return
    }
    const output = outputs.get(clip.id)
    outputs.delete(clip.id)
    if (!output) {
      session.playbackFailed('The prepared speech output is unavailable')
      publish()
      return
    }
    const abort = new AbortController()
    const group = output.playback.openGroup(clip.id)
    const current = { clip, abort, group }
    playing = current
    let started = false
    try {
      const result = await group.enqueue({ id: clip.id, audio: clip.delivery.audio, signal: abort.signal, onStart: () => {
        started = true
        session.began(clip, Date.now())
        output.onPlaybackStart?.({ id: clip.id, text: clip.plan.text })
        publish()
      } })
      await group.finish()
      if (result === 'ended')
        session.ended(clip, Date.now())
      else if (result === 'failed')
        session.playbackFailed('Livestream audio playback failed')
      if (started) {
        started = false
        output.onPlaybackEnd?.({ id: clip.id, text: clip.plan.text }, { status: result })
      }
    }
    catch (error) {
      if (started)
        output.onPlaybackEnd?.({ id: clip.id, text: clip.plan.text }, { status: 'failed' })
      if (!abort.signal.aborted && playing === current)
        session.playbackFailed(errorMessageFrom(error) ?? 'Livestream audio playback failed')
    }
    finally {
      if (playing === current)
        playing = undefined
      publish()
      if (!disposed)
        pump()
    }
  }

  // Playback and preparation advance independently. Only one task owns each side.
  function pump() {
    if (disposed || session.snapshot().phase !== 'running')
      return
    if (session.due(Date.now())) {
      void stop(true)
      return
    }
    if (!playing) {
      const clip = session.take(Date.now())
      if (clip)
        void play(clip)
    }
    if (!generation && !retry) {
      const work = session.reserve(Date.now())
      if (work) {
        generation = new AbortController()
        void prepare(work, generation)
      }
    }
    publish()
  }

  const cleanup = [
    context.on(livestreamRequestSnapshot, publish),
    context.on(livestreamBatch, ({ body }) => {
      const parsed = safeParse(batchSchema, body)
      if (!parsed.success)
        return
      session.receive(parsed.output, Date.now())
      pump()
    }),
    defineInvokeHandler(context, livestreamCommand, async (input) => {
      const parsed = safeParse(commandSchema, input)
      if (!parsed.success || disposed)
        return { accepted: false }
      const command = parsed.output
      if (command.type === 'start') {
        if (command.characterId !== cards.activeCardId || voice.activeTurns.length > 0)
          return { accepted: false }
        const stopping = stop()
        const revision = commandRevision
        await stopping
        // A later stop or pause wins over a start that still waits for old playback.
        if (disposed || revision !== commandRevision || command.characterId !== cards.activeCardId || voice.activeTurns.length > 0)
          return { accepted: false }
        characterId = command.characterId
        session.start(nanoid(), command.settings, Date.now())
        if (command.settings.mode === 'text')
          startClock()
        pump()
        return { accepted: true }
      }
      if (command.sessionId !== session.snapshot().sessionId)
        return { accepted: false }
      switch (command.type) {
        case 'pause':
          await pause()
          break
        case 'stop':
          await stop()
          break
        case 'resume':
          if (characterId !== cards.activeCardId || voice.activeTurns.length > 0)
            return { accepted: false }
          session.resume()
          if (session.snapshot().settings.mode === 'text')
            startClock()
          if (mockEnabled)
            startMock()
          pump()
          break
        case 'redirect':
          session.redirect(command.direction)
          stopPreparation()
          pump()
          break
        case 'mock':
          source?.stop()
          source = new MockComments(command.sessionId, command.samples)
          mockEnabled = command.enabled
          if (mockEnabled && running.value)
            startMock()
          break
        case 'sample': {
          const sample = new MockComments(command.sessionId, command.samples).batch()
          // Delivery uses the same event as automatic simulation and future collectors.
          context.emit(livestreamBatch, sample)
          break
        }
        case 'comment': {
          if (!running.value || !command.nickname.trim() || !command.text.trim())
            return { accepted: false }
          const id = nanoid()
          // Manual viewers use the collector contract. Nicknames identify one simulated viewer within this source.
          context.emit(livestreamBatch, {
            sessionId: command.sessionId,
            batchId: id,
            source: 'manual',
            messages: [{ id, userId: command.nickname.trim(), nickname: command.nickname.trim(), text: command.text.trim(), createdAt: Date.now() }],
          })
          break
        }
      }
      publish()
      return { accepted: true }
    }),
    watch(() => cards.activeCardId, () => { void stop() }),
    watch(() => voice.activeTurns.length, (count) => {
      if (count > 0 && running.value)
        void pause()
    }),
  ]
  publish()
  onScopeDispose(() => {
    disposed = true
    cleanup.forEach(dispose => dispose())
    void stop()
  })
  return { running, speechRunning, pause }
}
