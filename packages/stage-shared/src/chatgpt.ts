import { defineInvokeEventa } from '@moeru/eventa'

/** Renderer snapshots contain account labels and permission state, never OAuth credentials. */
export interface ChatGPTAccount {
  id: string
  email?: string
  connected: boolean
  sharing: boolean
}

export interface ChatGPTSession {
  accounts: ChatGPTAccount[]
  activeId?: string
}

/** The main process streams a fixed Responses endpoint over the invocation that owns its cancellation. */
export type ChatGPTResponseFrame = { type: 'headers', status: number } | { type: 'chunk', text: string }

export const chatgptSession = defineInvokeEventa<ChatGPTSession>('chatgpt:session')
export const chatgptSignIn = defineInvokeEventa<ChatGPTSession, { accountId?: string }>('chatgpt:sign-in')
export const chatgptSelect = defineInvokeEventa<ChatGPTSession, { accountId: string }>('chatgpt:select')
export const chatgptSignOut = defineInvokeEventa<{ session: ChatGPTSession, revoked: boolean }>('chatgpt:sign-out')
export const chatgptModels = defineInvokeEventa<Array<{ slug: string, display_name: string }>>('chatgpt:models')
export const chatgptResponse = defineInvokeEventa<ChatGPTResponseFrame, { body: string }>('chatgpt:response')
