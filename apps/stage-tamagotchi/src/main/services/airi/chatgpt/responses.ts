import { array, boolean, looseObject, object, optional, parse, string, unknown } from 'valibot'

const itemSchema = looseObject({ type: optional(string()), role: optional(string()) })
const toolSchema = looseObject({ type: string() })
const requestSchema = object({
  model: string(),
  input: array(itemSchema),
  instructions: optional(string()),
  reasoning: optional(unknown()),
  include: optional(array(string())),
  text: optional(unknown()),
  tools: optional(array(toolSchema)),
  tool_choice: optional(unknown()),
  parallel_tool_calls: optional(boolean()),
})

/**
 * Projects AIRI Responses requests onto the fields accepted by ChatGPT plan usage.
 * The request remains stateless. Local tools use additional_tools without changing their names.
 * Function tools use non-strict mode to preserve AIRI's optional fields and nested parameter schemas.
 * See https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.
 */
export function prepareRequest(body: string): string {
  const request = parse(requestSchema, JSON.parse(body))
  const input = request.input.map(item => item.role === 'system' ? { ...item, role: 'developer' } : item)
  const functions = request.tools
    ?.filter(tool => tool.type === 'function' || tool.type === 'custom')
    .map(tool => tool.type === 'function' ? { ...tool, strict: false } : tool)
  const hosted = request.tools?.filter(tool => tool.type !== 'function' && tool.type !== 'custom')
  if (hosted?.some(tool => tool.type !== 'web_search'))
    throw new Error('CHATGPT_UNSUPPORTED_TOOL')
  if (functions?.length)
    input.push({ type: 'additional_tools', role: 'developer', tools: functions })
  return JSON.stringify({ ...request, input, tools: hosted, store: false, stream: true })
}
