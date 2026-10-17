import type { LivestreamCommand } from '../../../../services/livestream'

import en from '@proj-airi/i18n/locales/en'

import { defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/broadcast-channel'
import { createPinia, disposePinia } from 'pinia'
import { afterEach, expect, it } from 'vitest'
import { render } from 'vitest-browser-vue'
import { userEvent } from 'vitest/browser'
import { createI18n } from 'vue-i18n'

import LivestreamSettings from '../../livestream/livestream-settings.vue'

import { Session } from '../../../../libs/livestream/session'
import { livestreamCommand, livestreamRequestSnapshot, livestreamSnapshot } from '../../../../services/livestream'
import { useLivestreamSettingsStore } from '../../../../stores/livestream-settings'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()))

it('sends operator commands across the browser channel and displays host acknowledgements', async () => {
  localStorage.clear()
  const pinia = createPinia()
  cleanups.push(() => disposePinia(pinia), () => localStorage.clear())
  const channel = new BroadcastChannel('proj-airi:livestream')
  const { context } = createContext(channel)
  cleanups.push(() => channel.close())
  const session = new Session()
  const received: LivestreamCommand[] = []
  let mockEnabled = false
  function publish() {
    context.emit(livestreamSnapshot, { connected: true, state: session.snapshot(), mockEnabled })
  }
  cleanups.push(context.on(livestreamRequestSnapshot, publish))
  cleanups.push(defineInvokeHandler(context, livestreamCommand, (command) => {
    received.push(command)
    switch (command.type) {
      case 'start':
        session.start('broadcast', command.settings, Date.now())
        break
      case 'pause':
        session.pause()
        break
      case 'resume':
        session.resume()
        break
      case 'stop':
        session.stop()
        break
      case 'redirect':
        session.redirect(command.direction)
        break
      case 'mock':
        mockEnabled = command.enabled
        break
      case 'comment':
        session.receive({ sessionId: command.sessionId, batchId: 'manual', source: 'manual', messages: [{ id: 'manual', userId: command.nickname, nickname: command.nickname, text: command.text, createdAt: Date.now() }] }, Date.now())
        break
    }
    publish()
    return { accepted: true }
  }))
  const screen = render(LivestreamSettings, {
    props: { characterId: 'character', characterName: 'ReLU' },
    global: { plugins: [pinia, createI18n({ legacy: false, locale: 'en', messages: { en } })] },
  })
  const start = screen.getByRole('button', { name: 'Start 30-minute text rehearsal', exact: true })
  await expect.element(start).toBeDisabled()
  await screen.getByRole('textbox', { name: 'Main topic', exact: true }).fill('Campus stories')
  await expect.element(start).toBeDisabled()
  await screen.getByRole('button', { name: 'Insert blank template', exact: true }).click()
  await expect.element(screen.getByRole('textbox', { name: /^Episode brief \(Markdown\)/ })).toHaveValue(expect.stringContaining('# 本场直播内容'))
  await expect.element(screen.getByRole('button', { name: 'Insert blank template', exact: true })).toBeDisabled()
  await screen.getByRole('textbox', { name: /^Episode brief \(Markdown\)/ }).fill('The roommate is called Lin.')
  await userEvent.keyboard('{End}{Enter}I continue the story.')
  await expect.element(screen.getByRole('textbox', { name: /^Episode brief \(Markdown\)/ })).toHaveValue('The roommate is called Lin.\nI continue the story.')
  await screen.getByRole('textbox', { name: /^Episode brief \(Markdown\)/ }).fill('The roommate is called Lin.')
  await expect.element(start).toBeDisabled()
  await screen.getByRole('button', { name: 'Character Soul', exact: true }).click()
  await screen.getByRole('textbox', { name: /^Character Soul/ }).fill('I speak in the first person.')
  await screen.getByRole('button', { name: 'Broadcast rules', exact: true }).click()
  await screen.getByRole('textbox', { name: /^Broadcast rules/ }).fill('I finish each sentence before replying.')
  await screen.getByRole('button', { name: 'Episode', exact: true }).click()
  await expect.element(screen.getByRole('textbox', { name: /^Episode brief \(Markdown\)/ })).toHaveValue('The roommate is called Lin.')
  await screen.getByRole('button', { name: 'Save configuration', exact: true }).click()
  expect(useLivestreamSettingsStore(pinia).saved.config).toEqual({
    direction: 'Campus stories',
    details: 'The roommate is called Lin.',
    soul: 'I speak in the first person.',
    rules: 'I finish each sentence before replying.',
  })
  await expect.element(start).toBeEnabled()
  await start.click()
  await expect.element(screen.getByRole('button', { name: 'Pause livestream', exact: true })).toBeVisible()
  expect(received[0]).toEqual({ type: 'start', characterId: 'character', settings: { direction: 'Campus stories', details: 'The roommate is called Lin.', mode: 'text' } })

  await screen.getByRole('textbox', { name: 'Simulated viewer name', exact: true }).fill('阿杰')
  await screen.getByRole('textbox', { name: 'Simulated comment', exact: true }).fill('我也有同款室友，你后来怎么办？')
  await screen.getByRole('button', { name: 'Send comment', exact: true }).click()
  await expect.element(screen.getByRole('list', { name: 'Rehearsal transcript (newest first)' })).toHaveTextContent('我也有同款室友，你后来怎么办？')
  await expect.element(screen.getByRole('textbox', { name: 'Simulated comment', exact: true })).toHaveValue('')

  await screen.getByRole('button', { name: 'Send sample comments', exact: true }).click()
  await expect.poll(() => received.some(command => command.type === 'sample' && command.samples.length === 16)).toBe(true)
  await screen.getByRole('button', { name: 'Start random comments', exact: true }).click()
  await expect.element(screen.getByRole('button', { name: 'Stop random comments', exact: true })).toHaveAttribute('aria-pressed', 'true')

  await screen.getByRole('textbox', { name: 'Change direction', exact: true }).fill('Cafeteria stories')
  await screen.getByRole('button', { name: 'Apply direction', exact: true }).click()
  await expect.poll(() => session.snapshot().settings.direction).toBe('Cafeteria stories')
  await screen.getByRole('button', { name: 'Pause livestream', exact: true }).click()
  await expect.element(screen.getByRole('button', { name: 'Resume livestream', exact: true })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: 'Send sample comments', exact: true })).toBeDisabled()
  await screen.getByRole('button', { name: 'Resume livestream', exact: true }).click()
  await expect.element(screen.getByRole('button', { name: 'Pause livestream', exact: true })).toBeVisible()
  await screen.getByRole('button', { name: 'Stop immediately', exact: true }).click()
  await expect.element(start).toBeVisible()
  expect(received.filter(command => command.type !== 'start').every(command => command.sessionId === 'broadcast')).toBe(true)
})
