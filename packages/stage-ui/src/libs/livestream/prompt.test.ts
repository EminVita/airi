import type { GenerationProvider, GenerationRequest } from '@proj-airi/provider-inference'

import { describe, expect, it, vi } from 'vitest'

import { createPlannerProvider } from './prompt'

describe('livestream provider policy', () => {
  it('uses low reasoning for ChatGPT without mutating ordinary chat requests', () => {
    const request: GenerationRequest = { protocol: 'responses', webSearch: true, config: { apiKey: '', baseURL: 'https://example.test/', model: 'gpt-6.1-sol', reasoning: { effort: 'medium' } } }
    const provider: GenerationProvider = { generation: vi.fn(() => request) }
    const result = createPlannerProvider(provider, 'chatgpt').generation('gpt-6.1-sol')
    expect(result).toMatchObject({ webSearch: false, config: { reasoning: { effort: 'low' } } })
    expect(request).toMatchObject({ webSearch: true, config: { reasoning: { effort: 'medium' } } })
    expect(provider.generation).toHaveBeenCalledWith('gpt-6.1-sol', undefined)
  })

  it('disables hosted search while preserving another provider reasoning configuration', () => {
    const request: GenerationRequest = { protocol: 'responses', webSearch: true, config: { apiKey: '', baseURL: 'https://example.test/', model: 'other', reasoning: { effort: 'high' } } }
    const provider: GenerationProvider = { generation: () => request }
    expect(createPlannerProvider(provider, 'other').generation('other')).toMatchObject({ webSearch: false, config: { reasoning: { effort: 'high' } } })
  })

  it('leaves chat completion requests under their provider policy', () => {
    const request: GenerationRequest = { protocol: 'chat-completions', config: { apiKey: '', baseURL: 'https://example.test/', model: 'other' } }
    const provider: GenerationProvider = { generation: () => request }
    expect(createPlannerProvider(provider, 'other').generation('other')).toBe(request)
  })
})
