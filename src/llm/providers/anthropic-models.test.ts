import { describe, expect, it } from 'vitest'
import { anthropicModelRules, thinkingParam } from './anthropic-models.js'

describe('Anthropic model request rules', () => {
  it.each([
    // model, non-default temperature, prefill, adaptive thinking, can turn thinking off, server fallback
    ['claude-haiku-5-5', false, false, true, true, false],
    ['claude-haiku-4-5-20251001', true, true, false, false, false],
    ['claude-haiku-4-5', true, true, false, false, false],
    ['claude-sonnet-4-20250514', true, true, false, false, false],
    ['claude-opus-4-6', true, false, true, true, false],
    ['claude-sonnet-4-6', true, false, true, true, false],
    ['claude-opus-4-7', false, false, true, true, false],
    ['claude-opus-4-8', false, false, true, true, false],
    ['claude-opus-5', false, false, true, true, true],
    ['claude-opus-5-5', false, false, true, false, true],
    ['claude-sonnet-5', false, false, true, true, false],
    ['claude-sonnet-5-5', false, false, true, false, true],
    ['claude-fable-5-1', false, false, true, false, true],
  ])('%s', (model, sampling, prefill, adaptive, canDisable, fallback) => {
    const rules = anthropicModelRules(model)
    expect(rules.samplingParams).toBe(sampling)
    expect(rules.assistantPrefill).toBe(prefill)
    expect(rules.adaptiveThinking).toBe(adaptive)
    expect(rules.canDisableThinking).toBe(canDisable)
    expect(rules.serverFallback).toBe(fallback)
  })

  it('turns thinking off by default only on Claude Haiku 5.5', () => {
    expect(anthropicModelRules('claude-haiku-5-5').defaultThinking).toBe('disabled')
    expect(anthropicModelRules('claude-opus-5-5').defaultThinking).toBeUndefined()
    expect(anthropicModelRules('claude-haiku-4-5').defaultThinking).toBeUndefined()
  })
})

describe('thinking request field', () => {
  it('honors a requested mode the model supports', () => {
    expect(thinkingParam(anthropicModelRules('claude-haiku-5-5'), 'adaptive')).toEqual({ type: 'adaptive' })
    expect(thinkingParam(anthropicModelRules('claude-opus-4-6'), 'disabled')).toEqual({ type: 'disabled' })
  })
  it('falls back to the model default for a mode it cannot honor', () => {
    expect(thinkingParam(anthropicModelRules('claude-opus-5-5'), 'disabled')).toBeUndefined()
    expect(thinkingParam(anthropicModelRules('claude-haiku-4-5'), 'adaptive')).toBeUndefined()
  })
  it('uses the per-model default when nothing is requested', () => {
    expect(thinkingParam(anthropicModelRules('claude-haiku-5-5'))).toEqual({ type: 'disabled' })
    expect(thinkingParam(anthropicModelRules('claude-opus-5-5'))).toBeUndefined()
  })
})
