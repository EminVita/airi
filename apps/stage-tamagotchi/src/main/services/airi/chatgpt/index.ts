import type { ElectronMainEmitOptions } from '@moeru/eventa/adapters/electron/main'
import type { ChatGPTResponseFrame } from '@proj-airi/stage-shared/chatgpt'
import type { Lifecycle } from 'injeca'

import { defineInvokeHandler, defineStreamInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/main'
import { chatgptModels, chatgptResponse, chatgptSelect, chatgptSession, chatgptSignIn, chatgptSignOut } from '@proj-airi/stage-shared/chatgpt'
import { app, ipcMain, net, shell } from 'electron'
import { object, optional, parse, string } from 'valibot'

import { isLocalAppURL } from '../../../libs/electron/url'
import { ChatGPTClient } from './client'
import { prepareRequest } from './responses'

function requireRenderer(options?: ElectronMainEmitOptions) {
  const event = options?.raw.ipcMainEvent
  if (!event?.senderFrame || event.senderFrame !== event.sender.mainFrame || !isLocalAppURL(event.senderFrame.url))
    throw new Error('CHATGPT_UNTRUSTED_RENDERER')
}

/** Registers the desktop credential boundary. Shutdown aborts sign-in and inference before disposing IPC. */
export function setupChatGPT(options: { lifecycle: Lifecycle }) {
  const client = new ChatGPTClient({
    directory: app.getPath('userData'),
    fetch: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
    openExternal: url => shell.openExternal(url),
  })
  const eventa = createContext(ipcMain)
  defineInvokeHandler(eventa.context, chatgptSession, (_, options) => {
    requireRenderer(options)
    return client.session()
  })
  defineInvokeHandler(eventa.context, chatgptSignIn, (payload, options) => {
    requireRenderer(options)
    const { accountId } = parse(object({ accountId: optional(string()) }), payload)
    return client.signIn(accountId, options?.abortController?.signal)
  })
  defineInvokeHandler(eventa.context, chatgptSelect, (payload, options) => {
    requireRenderer(options)
    return client.select(parse(object({ accountId: string() }), payload).accountId)
  })
  defineInvokeHandler(eventa.context, chatgptSignOut, (_, options) => {
    requireRenderer(options)
    return client.signOut()
  })
  defineInvokeHandler(eventa.context, chatgptModels, (_, options) => {
    requireRenderer(options)
    return client.models()
  })
  defineStreamInvokeHandler(eventa.context, chatgptResponse, async function* (payload, options): AsyncGenerator<ChatGPTResponseFrame> {
    requireRenderer(options)
    const { body } = parse(object({ body: string() }), payload)
    const response = await client.request('responses', prepareRequest(body), options?.abortController?.signal)
    yield { type: 'headers', status: response.status }
    if (!response.body)
      throw new Error('CHATGPT_EMPTY_RESPONSE')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done)
          break
        yield { type: 'chunk', text: decoder.decode(value, { stream: true }) }
      }
      const tail = decoder.decode()
      if (tail)
        yield { type: 'chunk', text: tail }
    }
    finally {
      await reader.cancel()
      reader.releaseLock()
    }
  })
  options.lifecycle.appHooks.onStop(() => {
    client.dispose()
    eventa.dispose()
  })
  return client
}
