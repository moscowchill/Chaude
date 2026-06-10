/**
 * Tests for LLMMiddleware chat-mode transformation, focused on prompt caching:
 * cache_control must reach the provider request (system prompt + message marker).
 *
 * Run with: npm test -- middleware
 */

import { describe, it, expect } from 'vitest'
import { LLMMiddleware, LLMProvider, ProviderRequest, AnthropicContentBlock } from './middleware.js'
import type { LLMRequest, ModelConfig, LLMCompletion, ParticipantMessage } from '../types.js'

function makeConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    model: 'claude-haiku-4-5-20251001',
    temperature: 1.0,
    max_tokens: 4096,
    top_p: 1.0,
    mode: 'chat',
    botName: 'Chaude',
    ...overrides,
  }
}

function msg(participant: string, text: string, cacheControl?: boolean): ParticipantMessage {
  const m: ParticipantMessage = {
    participant,
    content: [{ type: 'text', text }],
  }
  if (cacheControl) {
    m.cacheControl = { type: 'ephemeral' }
  }
  return m
}

/** Capture the ProviderRequest the middleware hands to the provider */
async function transform(request: LLMRequest): Promise<ProviderRequest> {
  const middleware = new LLMMiddleware()
  let captured: ProviderRequest | undefined
  const stub: LLMProvider = {
    name: 'anthropic',
    supportedModes: ['prefill', 'chat'],
    complete: async (req: ProviderRequest): Promise<LLMCompletion> => {
      captured = req
      return {
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0 },
        model: req.model,
      }
    },
  }
  middleware.registerProvider(stub, 'anthropic')
  middleware.setVendorConfigs({ anthropic: { provides: ['claude-*'] } } as never)
  await middleware.complete(request)
  if (!captured) throw new Error('provider was not called')
  return captured
}

function blocksOf(content: string | AnthropicContentBlock[]): AnthropicContentBlock[] {
  expect(Array.isArray(content)).toBe(true)
  return content as AnthropicContentBlock[]
}

describe('transformToChat prompt caching', () => {
  it('adds cache_control to the system prompt when caching is enabled (default)', async () => {
    const req = await transform({
      messages: [msg('Alice', 'hi')],
      system_prompt: 'You are a helpful bot.',
      config: makeConfig(),
    })

    const system = req.messages.find(m => m.role === 'system')
    expect(system).toBeDefined()
    const blocks = blocksOf(system!.content)
    expect(blocks[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  it('keeps system prompt as plain string when caching is disabled', async () => {
    const req = await transform({
      messages: [msg('Alice', 'hi')],
      system_prompt: 'You are a helpful bot.',
      config: makeConfig({ prompt_caching: false }),
    })

    const system = req.messages.find(m => m.role === 'system')
    expect(typeof system!.content).toBe('string')
  })

  it('puts cache_control on the persona prompt (last system block) when chatPersonaPrompt is set', async () => {
    const req = await transform({
      messages: [msg('Alice', 'hi')],
      system_prompt: 'You are a helpful bot.',
      config: makeConfig({ chatPersonaPrompt: true }),
    })

    const systems = req.messages.filter(m => m.role === 'system')
    expect(systems).toHaveLength(2)
    // Only the LAST system block should carry the marker (one breakpoint caches both)
    const first = systems[0]!.content
    const last = blocksOf(systems[1]!.content)
    expect(typeof first === 'string' || !(first as AnthropicContentBlock[])[0]!.cache_control).toBe(true)
    expect(last[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  it('splits a merged user message at the cache marker: stable prefix cached, tail uncached', async () => {
    const req = await transform({
      messages: [
        msg('Alice', 'old message 1'),
        msg('Bob', 'old message 2', true),  // cache marker here
        msg('Alice', 'new message 3'),
      ],
      config: makeConfig(),
    })

    const user = req.messages.find(m => m.role === 'user')
    const blocks = blocksOf(user!.content)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.text).toBe('Alice: old message 1\nBob: old message 2')
    expect(blocks[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(blocks[1]!.text).toBe('Alice: new message 3')
    expect(blocks[1]!.cache_control).toBeUndefined()
  })

  it('adds cache_control to a marked bot (assistant) message', async () => {
    const req = await transform({
      messages: [
        msg('Alice', 'question'),
        msg('Chaude', 'bot answer', true),  // marker on the bot message
        msg('Alice', 'follow-up'),
      ],
      config: makeConfig(),
    })

    const assistant = req.messages.find(m => m.role === 'assistant')
    const blocks = blocksOf(assistant!.content)
    expect(blocks[0]!.text).toBe('bot answer')
    expect(blocks[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  it('emits no cache_control anywhere when caching is disabled', async () => {
    const req = await transform({
      messages: [
        msg('Alice', 'a'),
        msg('Bob', 'b', true),
        msg('Alice', 'c'),
      ],
      system_prompt: 'sys',
      config: makeConfig({ prompt_caching: false }),
    })

    const serialized = JSON.stringify(req.messages)
    expect(serialized).not.toContain('cache_control')
  })

  it('places images after the cached prefix block so image churn does not bust the cache', async () => {
    const imageMsg: ParticipantMessage = {
      participant: 'Alice',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image', source: { type: 'base64', data: 'AAAA', media_type: 'image/png' } } as never,
      ],
    }
    const req = await transform({
      messages: [msg('Bob', 'older context', true), imageMsg],
      config: makeConfig(),
    })

    const user = req.messages.find(m => m.role === 'user')
    const blocks = blocksOf(user!.content)
    const cachedIdx = blocks.findIndex(b => b.cache_control)
    const imageIdx = blocks.findIndex(b => b.type === 'image')
    expect(cachedIdx).toBe(0)
    expect(imageIdx).toBeGreaterThan(cachedIdx)
  })

  it('appends persona prefill as a new block instead of mutating a cached block', async () => {
    const req = await transform({
      messages: [msg('Alice', 'only message', true)],  // marker on the very last message
      config: makeConfig({ chatPersonaPrefill: true }),
    })

    const user = req.messages.find(m => m.role === 'user')
    const blocks = blocksOf(user!.content)
    // Cached block must be untouched; prefill lands in its own uncached block
    expect(blocks[0]!.text).toBe('Alice: only message')
    expect(blocks[0]!.cache_control).toBeDefined()
    expect(blocks[blocks.length - 1]!.text).toContain('Chaude:')
    expect(blocks[blocks.length - 1]!.cache_control).toBeUndefined()
  })
})
