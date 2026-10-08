/**
 * Request rules for Claude models whose Messages API surface changed.
 *
 * - Claude Haiku 5.5, the other 5.x models, Opus 4.7/4.8 and Fable accept only the
 *   default sampling: any other `temperature` returns a 400.
 * - From the 4.6 family on, a conversation must end with a user turn (an assistant
 *   prefill returns a 400), thinking is adaptive (`thinking: {type: 'adaptive'}`), and
 *   `output_config.effort` sets how much the model thinks and writes.
 * - Thinking can be turned off with `{type: 'disabled'}` on Haiku 5.5, Opus 5 and the
 *   4.6-4.8 family (at effort `high` or below on Haiku 5.5 and Opus 5). Opus 5.5 and
 *   Fable always think; Sonnet 5.5 turns thinking off only through `between_tools`,
 *   which Chaude does not send.
 * - Opus 5.5, Opus 5, Sonnet 5.5 and Fable 5.1 offer a server-side fallback when a
 *   safety classifier declines a request (`fallbacks: 'default'` under a beta header).
 *
 * Chaude's default for Haiku 5.5 is thinking off, which keeps replies in the Haiku 4.5
 * shape. A bot that sets `thinking: adaptive` gets thinking blocks, which the provider
 * returns verbatim so the tool loop can send them back unmodified.
 */
export interface AnthropicModelRules {
  /** A non-default temperature is accepted */
  samplingParams: boolean
  /** A conversation may end with an assistant turn (prefill) */
  assistantPrefill: boolean
  /** `thinking: {type: 'adaptive'}` and `output_config.effort` are accepted */
  adaptiveThinking: boolean
  /** Thinking can be turned off with `{type: 'disabled'}` */
  canDisableThinking: boolean
  /** Thinking mode Chaude uses when the request does not choose one */
  defaultThinking?: 'disabled'
  /** Server-side refusal fallback is available */
  serverFallback: boolean
  /** `output_config.format` with a JSON schema (structured output) is accepted */
  structuredOutputs: boolean
}

const DEFAULT_SAMPLING_ONLY = /^claude-(?:haiku-5|sonnet-5|opus-5|opus-4-[78]|fable-|mythos-)/
const CURRENT_FAMILY = /^claude-(?:haiku-5|sonnet-5|opus-5|opus-4-[678]|sonnet-4-6|fable-|mythos-)/
const ALWAYS_THINKS = /^claude-(?:opus-5-5|sonnet-5-5|fable-|mythos-)/
const THINKING_OFF_BY_DEFAULT = /^claude-haiku-5-5(?:$|-)/
const SERVER_FALLBACK = /^claude-(?:opus-5|sonnet-5-5|fable-5-1)(?:$|-)/
const STRUCTURED_OUTPUTS = /^claude-(?:haiku-5|sonnet-5|opus-5|opus-4-[5678]|sonnet-4-[56]|haiku-4-5|fable-|mythos-)/

export function anthropicModelRules(model: string): AnthropicModelRules {
  const current = CURRENT_FAMILY.test(model)
  return {
    samplingParams: !DEFAULT_SAMPLING_ONLY.test(model),
    assistantPrefill: !current,
    adaptiveThinking: current,
    canDisableThinking: current && !ALWAYS_THINKS.test(model),
    ...(THINKING_OFF_BY_DEFAULT.test(model) ? { defaultThinking: 'disabled' as const } : {}),
    serverFallback: SERVER_FALLBACK.test(model),
    structuredOutputs: STRUCTURED_OUTPUTS.test(model),
  }
}

/**
 * The `thinking` request field for a model and an optional requested mode. A mode the
 * model can't honor falls back to the model's own default (no field).
 */
export function thinkingParam(
  rules: AnthropicModelRules,
  requested?: 'adaptive' | 'disabled'
): { type: 'adaptive' } | { type: 'disabled' } | undefined {
  const mode = requested ?? rules.defaultThinking
  if (mode === 'adaptive' && rules.adaptiveThinking) return { type: 'adaptive' }
  if (mode === 'disabled' && rules.canDisableThinking) return { type: 'disabled' }
  return undefined
}
