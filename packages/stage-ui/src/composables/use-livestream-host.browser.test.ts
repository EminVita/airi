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

import { getLivestreamContext, livestreamCommand, livestreamSnapshot } from '../services/livestream'
import { useLLM } from '../stores/ai/chat-llm/llm'
import { useAiriCardStore } from '../stores/modules/airi-card'
import { useProviderStore } from '../stores/providers/provider'
import { useLivestreamHost } from './use-livestream-host'

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

function sentence(text: string): Plan {
  return { action: 'continue', text, topic: 'Campus', checkpoint: text, segmentComplete: false, replyToIds: [], skipIds: [], allowed: true }
}

it('cancels pending generation and synthesis, stops audio, and resumes from the completed checkpoint without provider calls', async () => {
  localStorage.clear()
  // The test isolates all network access, including unrelated store initialization.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ voices: [], recommended: {}, data: [] })))
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
  await invoke({ type: 'start', characterId: 'default', settings: { direction: 'Campus', details: '' } })
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
