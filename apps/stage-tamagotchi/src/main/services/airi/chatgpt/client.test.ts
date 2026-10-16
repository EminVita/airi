import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChatGPTClient } from './client'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'test-keyring',
    encryptString: (value: string) => Buffer.from(Buffer.from(value).toString('base64')),
    decryptString: (value: Buffer) => Buffer.from(value.toString(), 'base64').toString(),
  },
}))

const fixtures: Array<{ directory: string, client: ChatGPTClient }> = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.client.dispose()
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

async function fixture(options: { nonce?: string, audience?: string, scope?: string, expiresIn?: number, failExchange?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'airi-chatgpt-'))
  const keys = await generateKeyPair('RS256')
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'test-key', alg: 'RS256' }
  let authorization: URL | undefined
  let returnedClientId = 'oaiapp_test'
  const remote = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/jwks.json'))
      return Response.json({ keys: [jwk] })
    if (url.endsWith('/openid-configuration'))
      return Response.json({ revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke' })
    if (url.endsWith('/revoke'))
      return new Response(null, { status: 200 })
    if (url.endsWith('/oauth/token')) {
      if (options.failExchange)
        return Response.json({ error: 'invalid_grant' }, { status: 400 })
      const body = new URLSearchParams(String(init?.body))
      if (body.get('grant_type') === 'refresh_token')
        return Response.json({ access_token: 'refreshed-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600 })
      const idToken = await new SignJWT({ nonce: options.nonce ?? authorization?.searchParams.get('nonce'), email: 'viewer@example.com' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer('https://auth.openai.com')
        .setAudience(options.audience ?? 'oaiapp_test')
        .setSubject('test-subject')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(keys.privateKey)
      return Response.json({ access_token: 'initial-access', refresh_token: 'initial-refresh', id_token: idToken, token_type: 'Bearer', expires_in: options.expiresIn ?? 3600, scope: options.scope ?? 'openid chatgpt.tokens.use.direct' })
    }
    if (url.endsWith('/models'))
      return Response.json({ models: [{ slug: 'available-model', display_name: 'Available', visibility: 'list' }, { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hidden' }] })
    if (url.endsWith('/responses'))
      return new Response('data: {"type":"response.completed"}\n\n')
    throw new Error(`Unexpected test endpoint: ${url}`)
  })
  const openExternal = vi.fn(async (raw: string) => {
    authorization = new URL(raw)
    const callback = new URL(authorization.searchParams.get('redirect_uri')!)
    callback.search = new URLSearchParams({ code: 'test-code', state: authorization.searchParams.get('state')!, client_id: returnedClientId }).toString()
    const response = await fetch(callback)
    expect(response.status).toBe(200)
  })
  const client = new ChatGPTClient({ directory, fetch: remote, openExternal })
  fixtures.push({ directory, client })
  return {
    client,
    directory,
    remote,
    openExternal,
    setClientId: (id: string) => {
      returnedClientId = id
    },
  }
}

describe('chatGPT local account lifecycle', () => {
  it('verifies identity, persists the host and credentials, and returns only public account state', async () => {
    const f = await fixture()
    const session = await f.client.signIn()
    expect(session.accounts[0]).toMatchObject({ email: 'viewer@example.com', connected: true, sharing: true })
    expect(JSON.stringify(session)).not.toContain('initial-access')
    const authorization = new URL(f.openExternal.mock.calls[0][0])
    expect(authorization.searchParams.get('client_id')).toBe('dynamic_agent_client')
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/)
    expect((await readFile(join(f.directory, 'chatgpt.bin'))).toString()).not.toContain('initial-refresh')
    expect(await f.client.models()).toEqual([{ slug: 'available-model', display_name: 'Available' }])

    const restored = new ChatGPTClient({ directory: f.directory, fetch: f.remote, openExternal: f.openExternal })
    expect(await restored.session()).toEqual(session)
    await restored.signIn(session.activeId)
    const returning = new URL(f.openExternal.mock.calls[1][0])
    expect(returning.searchParams.get('client_id')).toBe('oaiapp_test')
    expect(returning.searchParams.get('ext_agent_host_id')).toBe(authorization.searchParams.get('ext_agent_host_id'))
    expect(returning.searchParams.has('agent_name_hint')).toBe(false)
    restored.dispose()
  })

  it.each([{ nonce: 'wrong-nonce' }, { audience: 'wrong-audience' }])('rejects invalid identity claims: %j', async (options) => {
    const f = await fixture(options)
    await expect(f.client.signIn()).rejects.toThrow()
    const session = await f.client.session()
    expect(session.activeId).toBeUndefined()
    expect(session.accounts[0].connected).toBe(false)
    await expect(f.client.request('responses', '{}')).rejects.toThrow('CHATGPT_SIGN_IN_REQUIRED')
  })

  it('retains an issued registration after exchange failure', async () => {
    const f = await fixture({ failExchange: true })
    await expect(f.client.signIn()).rejects.toThrow('CHATGPT_SIGN_IN_REQUIRED')
    const session = await f.client.session()
    await expect(f.client.signIn(session.accounts[0].id)).rejects.toThrow()
    expect(new URL(f.openExternal.mock.calls[1][0]).searchParams.get('client_id')).toBe('oaiapp_test')
  })

  it('does not treat identity-only consent as permission for inference', async () => {
    const f = await fixture({ scope: 'openid email' })
    const session = await f.client.signIn()
    expect(session.accounts[0].sharing).toBe(false)
    await expect(f.client.models()).rejects.toThrow('CHATGPT_PLAN_PERMISSION_REQUIRED')
    expect(f.remote.mock.calls.some(([url]) => String(url).endsWith('/models'))).toBe(false)
  })

  it('serializes rotating refresh tokens for simultaneous requests', async () => {
    const f = await fixture({ expiresIn: 30 })
    await f.client.signIn()
    await Promise.all([f.client.models(), f.client.models()])
    const refreshes = f.remote.mock.calls.filter(([, init]) => String(init?.body).includes('grant_type=refresh_token'))
    expect(refreshes).toHaveLength(1)
    expect(new URLSearchParams(String(refreshes[0][1]?.body)).get('client_id')).toBe('oaiapp_test')
    const requests = f.remote.mock.calls.filter(([url]) => String(url).endsWith('/models'))
    expect(new Headers(requests[0][1]?.headers).get('Authorization')).toBe('Bearer refreshed-access')
    expect(new Headers(requests[1][1]?.headers).get('Authorization')).toBe('Bearer refreshed-access')
  })

  it('rejects a changed client ID without overwriting the signed-in account', async () => {
    const f = await fixture()
    const session = await f.client.signIn()
    f.setClientId('oaiapp_different')
    await expect(f.client.signIn(session.activeId)).rejects.toThrow('CHATGPT_IDENTITY_MISMATCH')
    expect(await f.client.session()).toEqual(session)
  })

  it('cancels sign-in while the browser waits for consent', async () => {
    const f = await fixture()
    let opened!: () => void
    const ready = new Promise<void>((resolve) => {
      opened = resolve
    })
    f.openExternal.mockImplementationOnce(async () => opened())
    const controller = new AbortController()
    const result = f.client.signIn(undefined, controller.signal)
    const rejected = expect(result).rejects.toThrow('CHATGPT_SIGN_IN_FAILED')
    await ready
    controller.abort()
    await rejected
    expect((await f.client.session()).accounts).toEqual([])
  })

  it('revokes and clears tokens but preserves the registration for the next sign-in', async () => {
    const f = await fixture()
    const session = await f.client.signIn()
    const result = await f.client.signOut()
    expect(result.revoked).toBe(true)
    expect(result.session.accounts[0].connected).toBe(false)
    expect(result.session.activeId).toBe(session.activeId)
    await expect(f.client.models()).rejects.toThrow('CHATGPT_SIGN_IN_REQUIRED')
    await f.client.signIn(session.activeId)
    const returning = new URL(f.openExternal.mock.calls[1][0])
    expect(returning.searchParams.get('client_id')).toBe('oaiapp_test')
    expect(returning.searchParams.has('id_token_hint')).toBe(false)
  })

  it('clears revoked refresh credentials and keeps the account registration', async () => {
    const options = { expiresIn: 30, failExchange: false }
    const f = await fixture(options)
    const session = await f.client.signIn()
    options.failExchange = true
    await expect(f.client.models()).rejects.toThrow('CHATGPT_SIGN_IN_REQUIRED')
    expect((await f.client.session()).activeId).toBe(session.activeId)
    expect((await f.client.session()).accounts[0].connected).toBe(false)
  })

  it('reports unconfirmed remote revocation while still removing local tokens', async () => {
    const f = await fixture()
    await f.client.signIn()
    f.remote.mockRejectedValueOnce(new Error('offline'))
    const result = await f.client.signOut()
    expect(result.revoked).toBe(false)
    expect(result.session.accounts[0].connected).toBe(false)
    await expect(f.client.models()).rejects.toThrow('CHATGPT_SIGN_IN_REQUIRED')
  })

  it('aborts an active response when the user changes account selection', async () => {
    const f = await fixture()
    const session = await f.client.signIn()
    await f.client.request('responses', '{}')
    const request = f.remote.mock.calls.find(([url]) => String(url).endsWith('/responses'))
    expect(request?.[1]?.signal?.aborted).toBe(false)
    await f.client.select(session.activeId!)
    expect(request?.[1]?.signal?.aborted).toBe(true)
  })
})
