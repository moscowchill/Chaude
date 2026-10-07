import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderMessage, ProviderRequest } from '../middleware.js'
import { AnthropicProvider } from './anthropic.js'
import { logger } from '../../utils/logger.js'

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  stream: vi.fn(),
  countTokens: vi.fn(),
  betaCreate: vi.fn(),
  betaStream: vi.fn(),
}))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: sdk.create, stream: sdk.stream, countTokens: sdk.countTokens }
    beta = { messages: { create: sdk.betaCreate, stream: sdk.betaStream } }
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
const request = (model: string, extra: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model,
  messages: chat,
  temperature: 0.7,
  top_p: 1,
  max_tokens: 256,
  ...extra,
})
const reply = (content: unknown[], model = 'claude-haiku-5-5') => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model,
  stop_reason: 'end_turn',
  stop_sequence: null,
  content,
  usage: { input_tokens: 10, output_tokens: 5 },
})
const text = reply([{ type: 'text', text: 'A quantum-resistant ledger.' }])

const streamed = (message: unknown) => ({ finalMessage: () => Promise.resolve(message) })

beforeEach(() => {
  sdk.create.mockReset()
  sdk.betaCreate.mockReset()
  sdk.stream.mockReset().mockReturnValue(streamed(text))
  sdk.betaStream.mockReset().mockReturnValue(streamed(text))
  sdk.countTokens.mockReset().mockResolvedValue({ input_tokens: 42 })
})

describe('Anthropic provider with Claude Haiku 5.5', () => {
  it('sends no temperature and turns thinking off by default', async () => {
    await new AnthropicProvider('key').complete(request('claude-haiku-5-5'))
    const params = sdk.stream.mock.calls[0][0]
    expect(params).not.toHaveProperty('temperature')
    expect(params.thinking).toEqual({ type: 'disabled' })
    expect(params).not.toHaveProperty('output_config')
    expect(params.system).toBe('You are Chaude.')
    expect(params.messages).toEqual([{ role: 'user', content: 'alice: what is QRL?' }])
  })

  it('runs adaptive thinking at the configured effort when the bot asks for it', async () => {
    await new AnthropicProvider('key').complete(request('claude-haiku-5-5', { thinking: 'adaptive', effort: 'medium' }))
    const params = sdk.stream.mock.calls[0][0]
    expect(params.thinking).toEqual({ type: 'adaptive' })
    expect(params.output_config).toEqual({ effort: 'medium' })
  })

  it('returns thinking blocks verbatim for the tool loop, apart from the text', async () => {
    sdk.stream.mockReturnValue(streamed(
      reply([
        { type: 'thinking', thinking: '', signature: 'sig-1' },
        { type: 'redacted_thinking', data: 'opaque' },
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 'tu_1', name: 'save_note', input: { text: 'x' } },
      ])
    ))
    const completion = await new AnthropicProvider('key').complete(request('claude-haiku-5-5', { thinking: 'adaptive' }))
    expect(completion.content).toEqual([
      { type: 'thinking', thinking: '', signature: 'sig-1' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id: 'tu_1', name: 'save_note', input: { text: 'x' } },
    ])
  })

  it('drops a trailing assistant turn, which the model would reject as a prefill', async () => {
    const withPrefill: ProviderMessage[] = [...chat, { role: 'assistant', content: 'Chaude:' }]
    await new AnthropicProvider('key').complete(request('claude-haiku-5-5', { messages: withPrefill }))
    expect(sdk.stream.mock.calls[0][0].messages).toEqual([{ role: 'user', content: 'alice: what is QRL?' }])
  })

  it('warns once per request about a dropped prefill, not once per count and call', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
    const provider = new AnthropicProvider('key')
    const prefilled = request('claude-haiku-5-5', { messages: [...chat, { role: 'assistant', content: 'Chaude:' }] })
    await provider.countInputTokens(prefilled)
    await provider.complete(prefilled)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('tells the middleware that prefill mode cannot work', () => {
    expect(new AnthropicProvider('key').supportsPrefill('claude-haiku-5-5')).toBe(false)
    expect(new AnthropicProvider('key').supportsPrefill('claude-haiku-4-5-20251001')).toBe(true)
  })

  it('refuses a conversation without a user turn before calling the API', async () => {
    const onlyBot: ProviderMessage[] = [{ role: 'assistant', content: 'Something went wrong' }]
    await expect(
      new AnthropicProvider('key').complete(request('claude-haiku-5-5', { messages: onlyBot }))
    ).rejects.toThrow('Nothing to answer')
    expect(sdk.stream).not.toHaveBeenCalled()
  })

  it('counts tokens for the conversation and thinking setting it will send', async () => {
    const withPrefill: ProviderMessage[] = [...chat, { role: 'assistant', content: 'Chaude:' }]
    const tokens = await new AnthropicProvider('key').countInputTokens(
      request('claude-haiku-5-5', { messages: withPrefill, thinking: 'adaptive' })
    )
    expect(tokens).toBe(42)
    const params = sdk.countTokens.mock.calls[0][0]
    expect(params.messages).toEqual([{ role: 'user', content: 'alice: what is QRL?' }])
    expect(params.thinking).toEqual({ type: 'adaptive' })
  })
})

describe('Anthropic provider with Claude Opus 5.5', () => {
  it('uses the server-side fallback through the beta endpoint and never sends thinking: disabled', async () => {
    await new AnthropicProvider('key').complete(
      request('claude-opus-5-5', { thinking: 'disabled', effort: 'medium' })
    )
    expect(sdk.stream).not.toHaveBeenCalled()
    const params = sdk.betaStream.mock.calls[0][0]
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01'])
    expect(params.fallbacks).toBe('default')
    expect(params).not.toHaveProperty('thinking')
    expect(params).not.toHaveProperty('temperature')
    expect(params.output_config).toEqual({ effort: 'medium' })
  })

  it('streams every request, large ones included, and returns the final message', async () => {
    const completion = await new AnthropicProvider('key').complete(request('claude-opus-5-5', { max_tokens: 32_000 }))
    expect(sdk.betaStream.mock.calls[0][0].max_tokens).toBe(32_000)
    expect(completion.content).toEqual([{ type: 'text', text: 'A quantum-resistant ledger.' }])
    await new AnthropicProvider('key').complete(request('claude-haiku-5-5'))
    expect(sdk.stream).toHaveBeenCalledTimes(1)
    expect(sdk.create).not.toHaveBeenCalled()
    expect(sdk.betaCreate).not.toHaveBeenCalled()
  })
})

describe('Anthropic provider with Claude Opus 4.6', () => {
  it('sends the temperature without thinking and drops it with thinking on', async () => {
    await new AnthropicProvider('key').complete(request('claude-opus-4-6'))
    expect(sdk.stream.mock.calls[0][0].temperature).toBe(0.7)
    await new AnthropicProvider('key').complete(request('claude-opus-4-6', { thinking: 'adaptive' }))
    const params = sdk.stream.mock.calls[1][0]
    expect(params.thinking).toEqual({ type: 'adaptive' })
    expect(params).not.toHaveProperty('temperature')
  })
})

describe('Anthropic provider with Claude Haiku 4.5', () => {
  it('keeps the temperature and prefill, and ignores thinking settings it cannot take', async () => {
    const withPrefill: ProviderMessage[] = [...chat, { role: 'assistant', content: 'Chaude:' }]
    await new AnthropicProvider('key').complete(
      request('claude-haiku-4-5-20251001', { messages: withPrefill, thinking: 'adaptive', effort: 'low' })
    )
    const params = sdk.stream.mock.calls[0][0]
    expect(params.temperature).toBe(0.7)
    expect(params).not.toHaveProperty('thinking')
    expect(params).not.toHaveProperty('output_config')
    expect(params.messages).toHaveLength(2)
  })
})
