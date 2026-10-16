import type { ChatGPTSession } from '@proj-airi/stage-shared/chatgpt'
import type { InferOutput } from 'valibot'

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { platform } from 'node:process'

import { errorMessageFrom } from '@moeru/std'
import { generateCodeChallenge, generateCodeVerifier, generateState } from '@proj-airi/stage-shared/auth'
import { Mutex } from 'async-mutex'
import { safeStorage } from 'electron'
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose'
import { array, literal, minLength, minValue, number, object, optional, parse, pipe, string } from 'valibot'

import { startLoopbackServer } from '../http-server/http/auth'

const issuer = 'https://auth.openai.com'
const resource = 'https://api.openai.com/v1'
const nonempty = pipe(string(), minLength(1))
const tokensSchema = object({
  access_token: nonempty,
  refresh_token: optional(nonempty),
  id_token: optional(nonempty),
  token_type: literal('Bearer'),
  expires_in: pipe(number(), minValue(1)),
  scope: optional(string()),
})
const accountSchema = object({
  id: nonempty,
  clientId: nonempty,
  subject: optional(nonempty),
  email: optional(string()),
  tokens: optional(object({ ...tokensSchema.entries, expiresAt: number() })),
})
const storageSchema = object({
  hostId: nonempty,
  activeId: optional(string()),
  accounts: array(accountSchema),
})
type Account = InferOutput<typeof accountSchema>

/**
 * Owns protected account registrations and serialized token rotation in the desktop main process.
 * Account changes cancel inference. Sign-in cancellation preserves the previous active account.
 * The app owns one instance until shutdown. No credential leaves this boundary.
 */
export class ChatGPTClient {
  private data?: InferOutput<typeof storageSchema>
  private loading?: Promise<void>
  private readonly lock = new Mutex()
  private readonly lifetime = new AbortController()
  private requests = new AbortController()
  private signInController?: AbortController
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>

  constructor(private readonly options: {
    directory: string
    fetch: typeof fetch
    openExternal: (url: string) => Promise<void>
  }) {
    this.jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { [customFetch]: options.fetch })
  }

  private async load() {
    this.loading ??= (async () => {
      if (!safeStorage.isEncryptionAvailable() || (platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'))
        throw new Error('CHATGPT_STORAGE_UNAVAILABLE')
      try {
        const encrypted = await readFile(join(this.options.directory, 'chatgpt.bin'))
        this.data = parse(storageSchema, JSON.parse(safeStorage.decryptString(encrypted)))
      }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
          throw new Error('CHATGPT_STORAGE_UNAVAILABLE')
        this.data = { hostId: `urn:uuid:${randomUUID()}`, accounts: [] }
        await this.save()
      }
    })()
    await this.loading
    if (!this.data)
      throw new Error('CHATGPT_STORAGE_UNAVAILABLE')
    return this.data
  }

  private async save() {
    const path = join(this.options.directory, 'chatgpt.bin')
    await mkdir(this.options.directory, { recursive: true })
    const temporary = `${path}.tmp`
    // Writes run under the account lock. Encryption also protects credentials on Windows, where mode does not set an ACL.
    await writeFile(temporary, safeStorage.encryptString(JSON.stringify(this.data)), { mode: 0o600 })
    await rename(temporary, path)
  }

  async session(): Promise<ChatGPTSession> {
    const data = await this.load()
    return {
      activeId: data.activeId,
      accounts: data.accounts.map(account => ({
        id: account.id,
        email: account.email,
        connected: !!account.tokens,
        sharing: account.tokens?.scope?.split(' ').includes('chatgpt.tokens.use.direct') === true,
      })),
    }
  }

  private signal(signal?: AbortSignal) {
    return AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : []), AbortSignal.timeout(30_000)])
  }

  private async exchange(body: URLSearchParams, signal?: AbortSignal) {
    const response = await this.options.fetch(`${issuer}/api/accounts/oauth/token`, {
      method: 'POST',
      body,
      signal: this.signal(signal),
      redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    if (!response.ok)
      throw new Error(response.status === 400 || response.status === 401 ? 'CHATGPT_SIGN_IN_REQUIRED' : 'CHATGPT_REQUEST_FAILED')
    return parse(tokensSchema, await response.json())
  }

  private async identity(token: string, account: Account, nonce?: string) {
    const { payload } = await jwtVerify(token, this.jwks, { issuer, audience: account.clientId, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat'] })
    if ((nonce && payload.nonce !== nonce) || (account.subject && payload.sub !== account.subject))
      throw new Error('CHATGPT_IDENTITY_MISMATCH')
    return { subject: payload.sub!, email: typeof payload.email === 'string' ? payload.email : undefined }
  }

  async signIn(accountId?: string, signal?: AbortSignal) {
    if (this.signInController)
      throw new Error('CHATGPT_SIGN_IN_BUSY')
    const controller = new AbortController()
    this.signInController = controller
    return this.lock.runExclusive(async () => {
      const data = await this.load()
      let account = accountId ? data.accounts.find(entry => entry.id === accountId) : undefined
      if (accountId && !account)
        throw new Error('CHATGPT_ACCOUNT_NOT_FOUND')
      const state = generateState()
      const nonce = generateState()
      const verifier = generateCodeVerifier()
      const challenge = await generateCodeChallenge(verifier)
      const attemptSignal = AbortSignal.any([this.lifetime.signal, controller.signal, ...(signal ? [signal] : [])])
      attemptSignal.throwIfAborted()
      const loopback = await startLoopbackServer(state)
      const cancel = () => loopback.close()
      attemptSignal.addEventListener('abort', cancel, { once: true })
      // Attach the callback rejection handler before opening the browser. Browser startup can fail while cancellation arrives.
      const callback = loopback.result.then(value => ({ value }), error => ({ error }))
      try {
        attemptSignal.throwIfAborted()
        const redirectUri = `http://127.0.0.1:${loopback.port}/callback`
        const url = new URL(`${issuer}/api/accounts/authorize`)
        url.search = new URLSearchParams({
          client_id: account?.clientId ?? 'dynamic_agent_client',
          ...(!account ? { agent_name_hint: 'AIRI' } : {}),
          ext_agent_host_id: data.hostId,
          response_type: 'code',
          redirect_uri: redirectUri,
          scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
          resource,
          state,
          nonce,
          code_challenge_method: 'S256',
          code_challenge: challenge,
          ...(account?.tokens?.id_token ? { id_token_hint: account.tokens.id_token } : {}),
        }).toString()
        await this.options.openExternal(url.toString())
        const result = await callback
        if ('error' in result)
          throw new Error('CHATGPT_SIGN_IN_FAILED')
        attemptSignal.throwIfAborted()
        const { code, clientId } = result.value
        if (account && clientId && clientId !== account.clientId)
          throw new Error('CHATGPT_IDENTITY_MISMATCH')
        if (!account) {
          if (!clientId || clientId === 'dynamic_agent_client')
            throw new Error('CHATGPT_SIGN_IN_FAILED')
          account = { id: randomUUID(), clientId }
          data.accounts.push(account)
          // Keep issued registration IDs even if exchange fails. Reauthorization must reuse the registration.
          await this.save()
        }
        const tokens = await this.exchange(new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: account.clientId,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          resource,
        }), attemptSignal)
        if (!tokens.id_token || tokens.scope === undefined)
          throw new Error('CHATGPT_SIGN_IN_FAILED')
        const identity = await this.identity(tokens.id_token, account, nonce)
        attemptSignal.throwIfAborted()
        this.cancelRequests()
        Object.assign(account, identity, { tokens: { ...tokens, expiresAt: Date.now() + tokens.expires_in * 1000 } })
        data.activeId = account.id
        await this.save()
        return this.session()
      }
      finally {
        attemptSignal.removeEventListener('abort', cancel)
        loopback.close()
      }
    }).finally(() => {
      this.signInController = undefined
    })
  }

  async select(accountId: string) {
    this.signInController?.abort()
    return this.lock.runExclusive(async () => {
      const data = await this.load()
      if (!data.accounts.some(account => account.id === accountId))
        throw new Error('CHATGPT_ACCOUNT_NOT_FOUND')
      this.cancelRequests()
      data.activeId = accountId
      await this.save()
      return this.session()
    })
  }

  async signOut() {
    this.signInController?.abort()
    this.cancelRequests()
    return this.lock.runExclusive(async () => {
      const data = await this.load()
      const account = data.accounts.find(entry => entry.id === data.activeId)
      let revoked = !account?.tokens
      if (account?.tokens) {
        try {
          const discovery = await this.options.fetch(`${issuer}/.well-known/openid-configuration`, { signal: this.signal(), redirect: 'error' })
          const metadata = parse(object({ revocation_endpoint: string() }), await discovery.json())
          const endpoint = new URL(metadata.revocation_endpoint)
          if (endpoint.origin !== issuer || !account.tokens.refresh_token)
            throw new Error('CHATGPT_REVOCATION_FAILED')
          const response = await this.options.fetch(endpoint, {
            method: 'POST',
            signal: this.signal(),
            redirect: 'error',
            body: new URLSearchParams({ token: account.tokens.refresh_token, token_type_hint: 'refresh_token', client_id: account.clientId }),
          })
          revoked = response.ok
        }
        catch {
          // Local sign-out still completes. The interface reports unconfirmed remote revocation and links to account settings.
          revoked = false
        }
        account.tokens = undefined
        await this.save()
      }
      return { session: await this.session(), revoked }
    })
  }

  private async accessToken() {
    return this.lock.runExclusive(async () => {
      const data = await this.load()
      const account = data.accounts.find(entry => entry.id === data.activeId)
      if (!account?.tokens)
        throw new Error('CHATGPT_SIGN_IN_REQUIRED')
      if (account.tokens.expiresAt <= Date.now() + 60_000) {
        if (!account.tokens.refresh_token)
          throw new Error('CHATGPT_SIGN_IN_REQUIRED')
        const previous = account.tokens
        const tokens = await this.exchange(new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: account.clientId,
          refresh_token: previous.refresh_token!,
          resource,
        })).catch(async (error) => {
          if (errorMessageFrom(error) === 'CHATGPT_SIGN_IN_REQUIRED') {
            account.tokens = undefined
            await this.save()
          }
          throw error
        })
        if (tokens.id_token)
          await this.identity(tokens.id_token, account)
        // OAuth refresh can omit unchanged scope and refresh token values. The previously granted values remain authoritative.
        account.tokens = {
          ...tokens,
          scope: tokens.scope ?? previous.scope,
          refresh_token: tokens.refresh_token ?? previous.refresh_token,
          id_token: tokens.id_token ?? previous.id_token,
          expiresAt: Date.now() + tokens.expires_in * 1000,
        }
        await this.save()
      }
      if (!account.tokens.scope?.split(' ').includes('chatgpt.tokens.use.direct'))
        throw new Error('CHATGPT_PLAN_PERMISSION_REQUIRED')
      return account.tokens.access_token
    })
  }

  async request(path: 'models' | 'responses', body?: string, signal?: AbortSignal) {
    // Capture the account lifetime before waiting for token rotation. A switch must never send an old conversation under the new account.
    const requestSignal = AbortSignal.any([this.lifetime.signal, this.requests.signal, ...(signal ? [signal] : []), AbortSignal.timeout(180_000)])
    const token = await this.accessToken()
    requestSignal.throwIfAborted()
    return this.options.fetch(`${resource}/${path}`, {
      method: body ? 'POST' : 'GET',
      body,
      signal: requestSignal,
      redirect: 'error',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    })
  }

  async models() {
    const response = await this.request('models')
    if (!response.ok)
      throw new Error(response.status === 401 ? 'CHATGPT_SIGN_IN_REQUIRED' : 'CHATGPT_REQUEST_FAILED')
    const catalog = parse(object({ models: array(object({ slug: string(), display_name: string(), visibility: string() })) }), await response.json())
    return catalog.models.filter(model => model.visibility === 'list').map(({ slug, display_name }) => ({ slug, display_name }))
  }

  private cancelRequests() {
    this.requests.abort()
    this.requests = new AbortController()
  }

  dispose() {
    this.lifetime.abort()
    this.cancelRequests()
  }
}
