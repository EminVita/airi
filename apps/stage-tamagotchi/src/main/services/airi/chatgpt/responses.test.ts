import { describe, expect, it } from 'vitest'

import { prepareRequest } from './responses'

describe('chatGPT plan requests', () => {
  it('preserves conversation and reasoning while applying plan restrictions', () => {
    const body = JSON.parse(prepareRequest(JSON.stringify({
      model: 'available-model',
      input: [{ type: 'message', role: 'system', content: 'Character instructions' }, { role: 'user', content: 'Hello' }],
      temperature: 0.7,
      top_p: 0.9,
      max_output_tokens: 10,
      store: true,
      stream: false,
      previous_response_id: 'old-response',
      reasoning: { effort: 'low' },
      include: ['reasoning.encrypted_content'],
    })))
    expect(body.input[0]).toEqual({ type: 'message', role: 'developer', content: 'Character instructions' })
    expect(body.input[1]).toEqual({ role: 'user', content: 'Hello' })
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
    expect(body.reasoning).toEqual({ effort: 'low' })
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('top_p')
    expect(body).not.toHaveProperty('max_output_tokens')
    expect(body).not.toHaveProperty('previous_response_id')
  })

  it('keeps local tool names and correlated results through additional_tools', () => {
    const tool = { type: 'function', name: 'set_expression', parameters: { type: 'object', properties: {} } }
    const history = [{ type: 'function_call', name: 'set_expression', call_id: 'call-1', arguments: '{}' }, { type: 'function_call_output', call_id: 'call-1', output: 'ok' }]
    const body = JSON.parse(prepareRequest(JSON.stringify({ model: 'available-model', input: history, tools: [tool, { type: 'web_search' }] })))
    expect(body.input.slice(0, 2)).toEqual(history)
    expect(body.input[2]).toEqual({ type: 'additional_tools', role: 'developer', tools: [{ ...tool, strict: false }] })
    expect(body.tools).toEqual([{ type: 'web_search' }])
  })

  it('preserves optional and nested tool parameters without strict schema requirements', () => {
    const parameters = {
      type: 'object',
      properties: { words: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' } } } } },
    }
    const tool = { type: 'function', name: 'configure_wake_words', parameters, strict: true }
    const custom = { type: 'custom', name: 'custom_tool' }
    const body = JSON.parse(prepareRequest(JSON.stringify({ model: 'available-model', input: [], tools: [tool, custom] })))
    expect(body.input[0].tools[0]).toEqual({ ...tool, strict: false })
    expect(body.input[0].tools[0].parameters).toEqual(parameters)
    expect(body.input[0].tools[1]).toEqual(custom)
  })

  it('rejects unsupported hosted tools and malformed requests before inference', () => {
    expect(() => prepareRequest(JSON.stringify({ model: 'model', input: [], tools: [{ type: 'tool_search' }] }))).toThrow('CHATGPT_UNSUPPORTED_TOOL')
    expect(() => prepareRequest(JSON.stringify({ model: 'model', input: 'hello' }))).toThrow()
  })
})
