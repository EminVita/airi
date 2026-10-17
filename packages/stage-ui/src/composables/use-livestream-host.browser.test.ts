import type { SpeechOutput } from '@proj-airi/core-agent'
import type { PlaybackClip, PlayedAudio } from '@proj-airi/pipelines-audio'

import type { Plan, Snapshot } from '../libs/livestream/session'
import type { LlmStreamOptions } from '../stores/ai/chat-llm/llm'

import en from '@proj-airi/i18n/locales/en'

import { defineInvoke } from '@moeru/eventa'
import { PiniaColada } from '@pinia/colada'
import { Playback } from '@proj-airi/pipelines-audio'
import { createPinia, disposePinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import { createI18n } from 'vue-i18n'

import soul from '../constants/prompts/soul.md?raw'
import speakingSkill from '../libs/livestream/prompts/haohao-shuohua/skill.md?raw'
import livestreamRules from '../libs/livestream/prompts/livestream-rules.md?raw'

import { getLivestreamContext, livestreamCommand, livestreamSnapshot } from '../services/livestream'
import { useLLM } from '../stores/ai/chat-llm/llm'
import { useAiriCardStore } from '../stores/modules/airi-card'
import { useProviderStore } from '../stores/providers/provider'
import { useLivestreamHost } from './use-livestream-host'

const cleanups: (() => void)[] = []
const localFetch = globalThis.fetch.bind(globalThis)

function isolateProviders() {
  // Local Vite assets retain their real MIME types and runtime implementations.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString(), location.href)
    if (url.href.startsWith('data:application/wasm') || (url.origin === location.origin && !url.pathname.startsWith('/api/')))
      return localFetch(input, init)
    return Response.json({ voices: [], recommended: {}, data: [] })
  }))
}
afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  localStorage.clear()
})

it('runs a complete 30-minute text rehearsal, accepts manual viewers, pauses its clock, and never opens speech output', async () => {
  localStorage.clear()
  isolateProviders()
  const pinia = createPinia()
  const openOutput = vi.fn<Parameters<typeof useLivestreamHost>[0]>()
  let cards: ReturnType<typeof useAiriCardStore> | undefined
  let initialized: Promise<void> | undefined
  let requestCount = 0
  const systemPrompts: string[] = []
  const briefs: string[] = []
  const remainingTimes: number[] = []
  const brief = '# 我本场想讲的故事\n我是小林，室友叫阿杰。先讲深夜泡面，再讲食堂的趣事。'
  const app = createApp({
    setup() {
      cards = useAiriCardStore()
      initialized = cards.initialize()
      vi.spyOn(useProviderStore(), 'getChatProviderInstance').mockResolvedValue({ generation: model => ({ protocol: 'chat-completions', config: { apiKey: '', baseURL: 'https://example.test/', model } }) })
      vi.spyOn(useLLM(), 'stream').mockImplementation(async (_model, _provider, conversation, options) => {
        requestCount++
        const systemTurn = conversation.turns[0]
        const userTurn = conversation.turns[1]
        if (systemTurn?.type !== 'system' || userTurn?.type !== 'user')
          throw new Error('The rehearsal must send its rules before its current state')
        const system = systemTurn.content[0]!
        const user = userTurn.content[0]!
        if (system.type !== 'text' || user.type !== 'text')
          throw new Error('The rehearsal must supply text instructions and context')
        systemPrompts.push(system.text)
        const input = JSON.parse(user.text) as { settings: { details: string }, topic: string, comments: { key: string }[], remainingMs: number }
        briefs.push(input.settings.details)
        remainingTimes.push(input.remainingMs)
        const comment = input.comments[0]
        const plan: Plan = {
          ...sentence(`我把第${requestCount}件小事记下，接着跟阿杰聊起了宿舍那晚的事。`),
          topic: input.topic,
          segmentComplete: !comment,
          action: comment ? 'reply' : 'continue',
          text: comment ? '我也觉得这事挺逗，阿杰当时差点笑出了声。' : `我把第${requestCount}件小事记下，接着跟阿杰聊起了宿舍那晚的事。`,
          replyToIds: comment ? [comment.key] : [],
        }
        await options?.onStreamEvent?.({ type: 'text-delta', text: JSON.stringify(plan) })
      })
      useLivestreamHost(openOutput)
      return () => null
    },
  })
  app.use(pinia).use(PiniaColada).use(createI18n({ legacy: false, locale: 'en', messages: { en } })).mount(document.createElement('div'))
  cleanups.push(() => disposePinia(pinia))
  cleanups.push(() => app.unmount())
  await initialized
  await cards!.updateActiveCardConsciousness({ provider: 'openai-compatible', model: 'test' })
  const identity = cards!.getIdentityPrompt('default')
  const ordinaryPrompt = cards!.getSystemPrompt('default')
  expect(identity).toContain(soul)
  expect(ordinaryPrompt).toContain(identity)
  expect(ordinaryPrompt).not.toContain(livestreamRules)
  const context = getLivestreamContext()
  let state: Snapshot | undefined
  cleanups.push(context.on(livestreamSnapshot, ({ body }) => {
    state = body?.state
  }))
  const invoke = defineInvoke(context, livestreamCommand)
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  await invoke({ type: 'start', characterId: 'default', settings: { direction: 'Campus', details: brief, mode: 'text' } })
  await vi.advanceTimersByTimeAsync(15_000)
  const sessionId = state!.sessionId
  expect(state?.phase).toBe('running')
  expect(state?.transcript.some(entry => entry.kind === 'host')).toBe(true)
  await invoke({ type: 'comment', sessionId, nickname: '模拟观众', text: '我也遇到过，你室友是不是也笑场了？' })
  await vi.advanceTimersByTimeAsync(25_000)
  expect(state?.transcript.some(entry => entry.kind === 'comment' && entry.nickname === '模拟观众')).toBe(true)
  expect(state?.transcript.some(entry => entry.action === 'reply' && entry.replies[0]?.nickname === '模拟观众')).toBe(true)
  await invoke({ type: 'pause', sessionId })
  const elapsed = state!.elapsedMs
  const callsBeforePause = requestCount
  const checkpoint = state!.checkpoint
  expect(state?.transcript.filter(entry => entry.kind === 'host').every(entry => entry.completed)).toBe(true)
  await vi.advanceTimersByTimeAsync(600_000)
  expect(state?.elapsedMs).toBe(elapsed)
  expect(requestCount).toBe(callsBeforePause)
  await invoke({ type: 'resume', sessionId })
  expect(state?.checkpoint).toBe(checkpoint)
  await vi.advanceTimersByTimeAsync(30 * 60_000 - elapsed)
  expect(state?.phase).toBe('stopped')
  expect(state?.completed).toBe(true)
  expect(state?.elapsedMs).toBe(30 * 60_000)
  expect(state?.metrics.played).toBeGreaterThan(100)
  expect(state?.metrics.synthesizedCharacters).toBe(0)
  expect(state?.metrics.discardedCharacters).toBe(0)
  expect(openOutput).not.toHaveBeenCalled()
  expect(briefs.every(value => value === brief)).toBe(true)
  expect(systemPrompts.every(value => value.includes(speakingSkill))).toBe(true)
  expect(systemPrompts.every(value => value.startsWith(identity))).toBe(true)
  expect(systemPrompts.every(value => value.includes(livestreamRules))).toBe(true)
  expect(Math.min(...remainingTimes)).toBeLessThan(30_000)
  const finishedCalls = requestCount
  await vi.advanceTimersByTimeAsync(60_000)
  expect(requestCount).toBe(finishedCalls)

  const nextBrief = '# 林冲风雪山神庙\n我本场扮演林冲，讲到离开山神庙为止。'
  await invoke({ type: 'start', characterId: 'default', settings: { direction: '林冲风雪山神庙', details: nextBrief, mode: 'text' } })
  await vi.advanceTimersByTimeAsync(15_000)
  expect(briefs.slice(finishedCalls).length).toBeGreaterThan(0)
  expect(briefs.slice(finishedCalls).every(value => value === nextBrief)).toBe(true)
  expect(systemPrompts.slice(finishedCalls).every(value => value.startsWith(identity))).toBe(true)
  expect(cards!.getSystemPrompt('default')).toBe(ordinaryPrompt)
  expect(cards!.getIdentityPrompt('default')).toBe(identity)
  expect(openOutput).not.toHaveBeenCalled()
  await invoke({ type: 'stop', sessionId: state!.sessionId })
}, 30_000)

function sentence(text: string): Plan {
  return { action: 'continue', text, topic: 'Campus', checkpoint: text, segmentComplete: false, replyToIds: [], skipIds: [], allowed: true }
}

it('cancels pending generation and synthesis, stops audio, and resumes from the completed checkpoint without provider calls', async () => {
  localStorage.clear()
  // The test isolates all network access, including unrelated store initialization.
  isolateProviders()
  const pinia = createPinia()
  const requests: { result: ReturnType<typeof Promise.withResolvers<string>>, options: LlmStreamOptions | undefined }[] = []
  const synthesis: { result: ReturnType<typeof Promise.withResolvers<Blob>>, signal: AbortSignal | undefined }[] = []
  const clips: { clip: PlaybackClip, result: ReturnType<typeof Promise.withResolvers<PlayedAudio>> }[] = []
  const output: SpeechOutput = {
    synthesize: vi.fn((_request, signal) => {
      const result = Promise.withResolvers<Blob>()
      synthesis.push({ result, signal })
      return result.promise
    }),
    playback: new Playback({
      nowMs: () => performance.now(),
      play: (clip) => {
        const result = Promise.withResolvers<PlayedAudio>()
        clips.push({ clip, result })
        clip.onStart?.()
        return { done: result.promise, stop: async () => {
          const receipt = { throughMs: 0 }
          result.resolve(receipt)
          return receipt
        } }
      },
    }),
    onPlaybackStart: vi.fn(),
    onPlaybackEnd: vi.fn(),
  }
  let cards: ReturnType<typeof useAiriCardStore> | undefined
  let initialized: Promise<void> | undefined
  const app = createApp({
    setup() {
      cards = useAiriCardStore()
      initialized = cards.initialize()
      const providers = useProviderStore()
      vi.spyOn(providers, 'getChatProviderInstance').mockResolvedValue({ generation: model => ({ protocol: 'chat-completions', config: { apiKey: '', baseURL: 'https://example.test/', model } }) })
      vi.spyOn(useLLM(), 'stream').mockImplementation(async (_model, _provider, _conversation, options) => {
        const result = Promise.withResolvers<string>()
        requests.push({ result, options })
        const text = await result.promise
        await options?.onStreamEvent?.({ type: 'text-delta', text })
      })
      useLivestreamHost(async () => output)
      return () => null
    },
  })
  app.use(pinia).use(PiniaColada).use(createI18n({ legacy: false, locale: 'en', messages: { en } })).mount(document.createElement('div'))
  cleanups.push(() => disposePinia(pinia))
  cleanups.push(() => app.unmount())
  if (!cards)
    throw new Error('Character store did not initialize')
  await initialized
  await cards.updateActiveCardConsciousness({ provider: 'openai-compatible', model: 'test' })
  const context = getLivestreamContext()
  let state: Snapshot | undefined
  let snapshots = 0
  cleanups.push(context.on(livestreamSnapshot, ({ body }) => {
    state = body?.state
    snapshots++
  }))
  const invoke = defineInvoke(context, livestreamCommand)
  await invoke({ type: 'start', characterId: 'default', settings: { direction: 'Campus', details: '', mode: 'speech' } })
  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]!.options?.supportsTools).toBe(false)
  requests[0]!.result.resolve(JSON.stringify(sentence('我端着泡面，刚想开吃就听见敲门声。')))
  await expect.poll(() => synthesis.length).toBe(1)
  synthesis[0]!.result.resolve(new Blob(['simulated audio']))
  await expect.poll(() => clips.length).toBe(1)
  await expect.poll(() => requests.length).toBe(2)
  const sessionId = state!.sessionId
  expect(state?.metrics.played).toBe(0)
  await invoke({ type: 'pause', sessionId })
  expect(requests[1]!.options?.abortSignal?.aborted).toBe(true)
  const afterPause = snapshots
  requests[1]!.result.resolve(JSON.stringify(sentence('这句话必须丢弃。')))
  await expect.poll(() => snapshots).toBeGreaterThan(afterPause)
  await expect.poll(() => output.onPlaybackEnd).toHaveBeenCalledWith(expect.anything(), { status: 'stopped' })
  expect(state?.phase).toBe('paused')
  expect(state?.checkpoint).toBe('')
  expect(synthesis).toHaveLength(1)

  await invoke({ type: 'resume', sessionId })
  await expect.poll(() => requests.length).toBe(3)
  requests[2]!.result.resolve(JSON.stringify(sentence('我放下碗，起身去开门。')))
  await expect.poll(() => synthesis.length).toBe(2)
  await invoke({ type: 'stop', sessionId })
  expect(synthesis[1]!.signal?.aborted).toBe(true)
  const afterStop = snapshots
  synthesis[1]!.result.resolve(new Blob(['late simulated audio']))
  await expect.poll(() => snapshots).toBeGreaterThan(afterStop)
  expect(state?.phase).toBe('stopped')
  expect(state?.ready).toBe('')
  expect(clips).toHaveLength(1)
  expect(output.onPlaybackStart).toHaveBeenCalledTimes(1)
})
