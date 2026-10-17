import en from '@proj-airi/i18n/locales/en'

import { PiniaColada } from '@pinia/colada'
import { createPinia, disposePinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-vue'
import { defineComponent, h } from 'vue'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'

import LivestreamPage from './livestream.vue'

const cleanups: (() => void)[] = []
const localFetch = globalThis.fetch.bind(globalThis)

afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup())
  vi.unstubAllGlobals()
  localStorage.clear()
})

it('keeps unsaved episode edits until the operator explicitly discards them', async () => {
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString(), location.href)
    if (url.href.startsWith('data:application/wasm') || (url.origin === location.origin && !url.pathname.startsWith('/api/')))
      return localFetch(input, init)
    return Response.json({ voices: [], recommended: {}, data: [] })
  }))
  const pinia = createPinia()
  cleanups.push(() => disposePinia(pinia))
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/settings/livestream', component: LivestreamPage },
      { path: '/settings', component: defineComponent(() => () => h('div', 'Settings home')) },
    ],
  })
  await router.push('/settings/livestream')
  const screen = render(defineComponent(() => () => h(RouterView)), {
    global: { plugins: [pinia, PiniaColada, router, createI18n({ legacy: false, locale: 'en', messages: { en } })] },
  })
  await screen.getByRole('textbox', { name: 'Main topic', exact: true }).fill('My next story')
  await router.push('/settings')
  expect(router.currentRoute.value.path).toBe('/settings/livestream')
  await screen.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await expect.element(screen.getByRole('textbox', { name: 'Main topic', exact: true })).toHaveValue('My next story')
  await router.push('/settings')
  await screen.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect.poll(() => router.currentRoute.value.path).toBe('/settings')
})
