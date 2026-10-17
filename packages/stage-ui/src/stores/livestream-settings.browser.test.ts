import type { LeadershipMode, SyncedPiniaRuntime } from 'pinia-plugin-synced'

import { createPinia, disposePinia } from 'pinia'
import { createSyncedPiniaPlugin } from 'pinia-plugin-synced'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp } from 'vue'

import { defaultLivestreamConfig, useLivestreamSettingsStore } from './livestream-settings'

const contexts: { pinia: ReturnType<typeof createPinia>, runtime?: SyncedPiniaRuntime }[] = []

function setup(namespace?: string, leadership?: LeadershipMode) {
  const pinia = createPinia()
  const runtime = namespace ? createSyncedPiniaPlugin({ namespace, leadership, callTimeout: 2000 }) : undefined
  if (runtime)
    pinia.use(runtime.plugin)
  createApp({}).use(pinia)
  contexts.push({ pinia, runtime })
  return { store: useLivestreamSettingsStore(pinia), runtime }
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  for (const { pinia, runtime } of contexts.splice(0)) {
    runtime?.dispose()
    disposePinia(pinia)
  }
  vi.restoreAllMocks()
  localStorage.clear()
})

it('persists follower edits once and applies remote snapshots without new proposals', async () => {
  const namespace = `livestream-settings:${crypto.randomUUID()}`
  const leader = setup(namespace, 'leader-only')
  await vi.waitFor(() => expect(leader.runtime!.isLeader()).toBe(true))
  const follower = setup(namespace, 'follower-only')
  await vi.waitFor(() => expect(follower.runtime!.getLeaderId()).toBe(leader.runtime!.participantId))
  const persist = vi.spyOn(Storage.prototype, 'setItem')
  let leaderMutations = 0
  let followerMutations = 0
  leader.store.$subscribe(() => leaderMutations++, { flush: 'sync' })
  follower.store.$subscribe(() => followerMutations++, { flush: 'sync' })
  const config = { ...defaultLivestreamConfig, soul: 'I speak naturally.', rules: 'I finish a story beat.', direction: 'Campus', details: '# Episode' }
  const result = await follower.store.save(config, 0)
  expect(result).toMatchObject({ accepted: true, saved: { revision: 1, config } })
  await vi.waitFor(() => expect(follower.store.saved.config).toEqual(config))
  await new Promise(resolve => setTimeout(resolve, 80))
  expect(leaderMutations).toBe(1)
  expect(followerMutations).toBe(1)
  expect(persist.mock.calls.filter(([key]) => key === 'settings/livestream')).toHaveLength(1)
  expect(setup().store.saved).toEqual({ revision: 1, config })

  // A second editor with an old revision cannot overwrite the leader's newer content.
  expect(await follower.store.save({ ...config, details: 'Stale draft' }, 0)).toEqual({ accepted: false })
  expect(leader.store.saved.config.details).toBe('# Episode')
})

it('retains saved configuration when validation or storage fails', async () => {
  const { store } = setup()
  const original = store.saved
  await expect(store.save({ ...defaultLivestreamConfig, soul: ' ' }, 0)).rejects.toThrow()
  expect(store.saved).toBe(original)
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Storage is full', 'QuotaExceededError')
  })
  await expect(store.save({ ...defaultLivestreamConfig, details: 'New episode' }, 0)).rejects.toThrow('Storage is full')
  expect(store.saved).toBe(original)
})

it('reports unreadable storage without overwriting the original record', () => {
  localStorage.setItem('settings/livestream', '{broken')
  const { store } = setup()
  expect(store.loadError).not.toBe('')
  expect(store.saved.config).toEqual(defaultLivestreamConfig)
  expect(localStorage.getItem('settings/livestream')).toBe('{broken')
})
