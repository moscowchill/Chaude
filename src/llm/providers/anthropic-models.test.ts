import { describe, expect, it } from 'vitest'
import { anthropicModelRules } from './anthropic-models.js'

describe('Anthropic model request rules', () => {
  it.each([
    // model, non-default temperature accepted, assistant prefill accepted, thinking off
    ['claude-haiku-5-5', false, false, true],
    ['claude-haiku-4-5-20251001', true, true, false],
    ['claude-haiku-4-5', true, true, false],
    ['claude-sonnet-4-20250514', true, true, false],
    ['claude-opus-4-6', true, false, false],
    ['claude-sonnet-4-6', true, false, false],
    ['claude-opus-4-7', false, false, false],
    ['claude-opus-4-8', false, false, false],
    ['claude-opus-5-5', false, false, false],
    ['claude-sonnet-5-5', false, false, false],
    ['claude-fable-5-1', false, false, false],
  ])('%s', (model, sampling, prefill, thinkingOff) => {
    const rules = anthropicModelRules(model)
    expect(rules.samplingParams).toBe(sampling)
    expect(rules.assistantPrefill).toBe(prefill)
    expect(rules.thinking).toEqual(thinkingOff ? { type: 'disabled' } : undefined)
  })
})
