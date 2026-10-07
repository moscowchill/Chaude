import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderMessage, ProviderRequest } from '../middleware.js'
import { AnthropicProvider } from './anthropic.js'

const { create, countTokens } = vi.hoisted(() => ({ create: vi.fn(), countTokens: vi.fn() }))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create }
    beta = { messages: { countTokens } }
  },
}))
// The provider logs every request and response to disk; keep tests off the filesystem
vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => true),
}))

const chat: ProviderMessage[] = [
  { role: 'system', content: 'You are Chaude.' },
  { role: 'user', content: 'alice: what is QRL?' },
]
const request = (model: string, messages = chat): ProviderRequest => ({
  model,
  messages,
  temperature: 0.7,
  top_p: 1,
  max_tokens: 256,
})
const reply = (content: unknown[]) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  stop_reason: 'end_turn',
  stop_sequence: null,
  content,
  usage: { input_tokens: 10, output_tokens: 5 },
})

beforeEach(() => {
  create.mockReset().mockResolvedValue(reply([{ type: 'text', text: 'A quantum-resistant ledger.' }]))
  countTokens.mockReset().mockResolvedValue({ input_tokens: 42 })
})

describe('Anthropic provider with Claude Haiku 5.5', () => {
  it('sends no temperature and turns thinking off', async () => {
    await new AnthropicProvider('key').complete(request('claude-haiku-5-5'))
    const params = create.mock.calls[0][0]
    expect(params).not.toHaveProperty('temperature')
    expect(params.thinking).toEqual({ type: 'disabled' })
    expect(params.system).toBe('You are Chaude.')
    expect(params.messages).toEqual([{ role: 'user', content: 'alice: what is QRL?' }])
  })

  it('drops a trailing assistant turn, which the model would reject as a prefill', async () => {
    const withPrefill: ProviderMessage[] = [...chat, { role: 'assistant', content: 'Chaude:' }]
    await new AnthropicProvider('key').complete(request('claude-haiku-5-5', withPrefill))
    expect(create.mock.calls[0][0].messages).toEqual([{ role: 'user', content: 'alice: what is QRL?' }])
  })

  it('refuses a conversation without a user turn before calling the API', async () => {
    const onlyBot: ProviderMessage[] = [{ role: 'assistant', content: 'Something went wrong' }]
    await expect(new AnthropicProvider('key').complete(request('claude-haiku-5-5', onlyBot))).rejects.toThrow(
      'Nothing to answer'
    )
    expect(create).not.toHaveBeenCalled()
  })

  it('leaves thinking blocks out of the reply', async () => {
    create.mockResolvedValue(
      reply([
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'redacted_thinking', data: 'opaque' },
        { type: 'text', text: 'hi' },
      ])
    )
    const completion = await new AnthropicProvider('key').complete(request('claude-haiku-5-5'))
    expect(completion.content).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('counts tokens for the conversation and thinking setting it will send', async () => {
    const withPrefill: ProviderMessage[] = [...chat, { role: 'assistant', content: 'Chaude:' }]
    const tokens = await new AnthropicProvider('key').countInputTokens(request('claude-haiku-5-5', withPrefill))
    expect(tokens).toBe(42)
    const params = countTokens.mock.calls[0][0]
    expect(params.messages).toEqual([{ role: 'user', content: 'alice: what is QRL?' }])
    expect(params.thinking).toEqual({ type: 'disabled' })
  })
})

describe('Anthropic provider with Claude Haiku 4.5', () => {
  it('keeps the configured temperature, the prefill and the default thinking', async () => {
    const withPrefill: ProviderMessage[] = [...chat, { role: 'assistant', content: 'Chaude:' }]
    await new AnthropicProvider('key').complete(request('claude-haiku-4-5-20251001', withPrefill))
    const params = create.mock.calls[0][0]
    expect(params.temperature).toBe(0.7)
    expect(params).not.toHaveProperty('thinking')
    expect(params.messages).toHaveLength(2)
  })
})
