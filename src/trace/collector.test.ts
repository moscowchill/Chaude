import { describe, expect, it } from 'vitest'
import { TraceCollector } from './collector.js'

describe('overlapping LLM traces', () => {
  it('retains distinct calls when they finish out of order', () => {
    const trace = new TraceCollector('channel', 'message', 'bot')
    const first = trace.startLLMCall(0)
    const second = trace.startLLMCall(1)
    expect(first).not.toBe(second)
    trace.failLLMCall(second, { message: 'second failed', retryCount: 0 })
    expect(trace.getCurrentLLMCallId()).toBe(first)
    trace.completeLLMCall(
      first,
      { messageCount: 1, systemPromptLength: 0, hasTools: false, toolCount: 0 },
      { stopReason: 'end_turn', contentBlocks: 1, textLength: 2, toolUseCount: 0 },
      { inputTokens: 1, outputTokens: 1 },
      'test'
    )
    expect(trace.getLLMCallCount()).toBe(2)
    expect(trace.getCurrentLLMCallId()).toBeUndefined()
    expect(trace.startLLMCall(2)).not.toBe(first)
  })
})
