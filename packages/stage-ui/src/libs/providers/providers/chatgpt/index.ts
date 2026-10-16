import type { GenerationRequest } from '@proj-airi/provider-inference'

import { defineInvoke, defineStreamInvoke } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/renderer'
import { isElectronWindow, isStageTamagotchi } from '@proj-airi/stage-shared'
import { chatgptModels, chatgptResponse, chatgptSession } from '@proj-airi/stage-shared/chatgpt'
import { z } from 'zod'

import { defineProvider } from '../registry'

function connect() {
  if (!isStageTamagotchi() || !isElectronWindow(window))
    throw new Error('CHATGPT_DESKTOP_REQUIRED')
  return createContext(window.electron.ipcRenderer)
}

/** Streams inference through main-process IPC. Tokens and caller-supplied URLs never cross this provider boundary. */
function createProvider() {
  const eventa = connect()
  const stream = defineStreamInvoke(eventa.context, chatgptResponse)
  const fetchResponse: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    if (request.url !== 'https://api.openai.com/v1/responses' || request.method !== 'POST')
      throw new Error('CHATGPT_UNSUPPORTED_REQUEST')
    const reader = stream({ body: await request.text() }, { signal: request.signal }).getReader()
    try {
      const first = await reader.read()
      if (first.done || first.value.type !== 'headers')
        throw new Error('CHATGPT_EMPTY_RESPONSE')
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const frame = await reader.read()
            if (frame.done) {
              controller.close()
              reader.releaseLock()
            }
            else if (frame.value.type === 'chunk') {
              controller.enqueue(encoder.encode(frame.value.text))
            }
          }
          catch (error) {
            controller.error(error)
            reader.releaseLock()
          }
        },
        async cancel(reason) {
          await reader.cancel(reason)
          reader.releaseLock()
        },
      })
      return new Response(body, { status: first.value.status, headers: { 'Content-Type': first.value.status === 200 ? 'text/event-stream' : 'application/json' } })
    }
    catch (error) {
      await reader.cancel()
      reader.releaseLock()
      throw error
    }
  }
  return {
    generation(model: string): GenerationRequest {
      return { protocol: 'responses', webSearch: false, config: { apiKey: '', baseURL: 'https://api.openai.com/v1/', model, fetch: fetchResponse } }
    },
    dispose: eventa.dispose,
  }
}

export const providerChatGPT = defineProvider({
  id: 'chatgpt',
  name: 'ChatGPT',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.chatgpt.title'),
  description: 'Use your ChatGPT plan in the desktop app.',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.chatgpt.description'),
  tasks: ['chat'],
  icon: 'i-lobe-icons:openai',
  isAvailableBy: () => isStageTamagotchi(),
  capabilities: { chat: { generation: { supportedProtocols: ['responses'], defaultProtocol: 'responses' } } },
  createProviderConfig: () => z.object({}),
  createProvider,
  validationRequiredWhen: () => true,
  validators: {
    validateConfig: [({ t }) => ({
      id: 'chatgpt:session',
      name: t('settings.pages.providers.provider.chatgpt.title'),
      schedule: { mode: 'interval', intervalMs: 15_000 },
      validator: async () => {
        const eventa = connect()
        try {
          const session = await defineInvoke(eventa.context, chatgptSession)()
          const valid = session.accounts.some(account => account.id === session.activeId && account.sharing)
          const reason = valid ? '' : t('settings.pages.providers.provider.chatgpt.sign-in-required')
          return { valid, reason, reasonKey: '', errors: valid ? [] : [{ error: new Error(reason) }] }
        }
        finally {
          eventa.dispose()
        }
      },
    })],
  },
  extraMethods: {
    async listModelCatalog() {
      const eventa = connect()
      try {
        const models = await defineInvoke(eventa.context, chatgptModels)()
        return { models: models.map(model => ({ id: model.slug, name: model.display_name, provider: 'chatgpt' })), defaultModel: models[0]?.slug }
      }
      finally {
        eventa.dispose()
      }
    },
  },
})
