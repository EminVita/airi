import type {} from 'pinia-plugin-synced'
import type { InferOutput } from 'valibot'

import { errorMessageFrom } from '@moeru/std'
import { defineStore } from 'pinia'
import { check, integer, maxLength, minValue, number, object, parse, pipe, string } from 'valibot'
import { shallowRef } from 'vue'

import defaultSoul from '../constants/prompts/soul.md?raw'
import defaultRules from '../libs/livestream/prompts/livestream-rules.md?raw'

const markdown = pipe(string(), maxLength(12000), check(value => value.trim().length > 0))
export const livestreamConfigSchema = object({
  soul: markdown,
  rules: markdown,
  direction: pipe(string(), maxLength(200)),
  details: pipe(string(), maxLength(12000)),
})
export type LivestreamConfig = InferOutput<typeof livestreamConfigSchema>

const savedSchema = object({
  revision: pipe(number(), integer(), minValue(0)),
  config: livestreamConfigSchema,
})
const storageKey = 'settings/livestream'

export const defaultLivestreamConfig: LivestreamConfig = {
  soul: defaultSoul,
  rules: defaultRules,
  direction: '',
  details: '',
}

/** Defaults also support non-renderer prompt consumers, which have no local storage. */
function loadSettings() {
  const initial = { revision: 0, config: { ...defaultLivestreamConfig } }
  try {
    const saved = typeof localStorage === 'undefined' ? null : localStorage.getItem(storageKey)
    return { saved: saved ? parse(savedSchema, JSON.parse(saved)) : initial, error: '' }
  }
  catch (cause) {
    return { saved: initial, error: errorMessageFrom(cause) ?? 'Cannot read livestream settings' }
  }
}

/** Only the synchronized save action persists settings. Drafts belong to the editor. */
export const useLivestreamSettingsStore = defineStore('livestream-settings', () => {
  const loaded = loadSettings()
  const saved = shallowRef(loaded.saved)
  const loadError = shallowRef(loaded.error)

  async function save(config: LivestreamConfig, expectedRevision: number) {
    if (expectedRevision !== saved.value.revision)
      return { accepted: false as const }

    const next = parse(savedSchema, { config, revision: saved.value.revision + 1 })
    // Persist before publishing. A failed disk write must leave the saved configuration intact.
    localStorage.setItem(storageKey, JSON.stringify(next))
    saved.value = next
    loadError.value = ''
    return { accepted: true as const, saved: next }
  }

  return { saved, loadError, save }
}, {
  synced: { state: true, actions: ['save'] },
})
