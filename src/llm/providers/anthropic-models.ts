/**
 * Request rules for Claude models whose Messages API surface changed.
 *
 * - Claude Haiku 5.5, the other 5.x models, Opus 4.7/4.8 and Fable accept only the
 *   default sampling: any other `temperature` returns a 400.
 * - From the 4.6 family on, a conversation must end with a user turn: an assistant
 *   prefill returns a 400.
 * - Claude Haiku 5.5 thinks by default. Chaude sends `thinking: disabled` (accepted at
 *   effort `high` or below; the default effort is `medium`) so its replies keep the
 *   Haiku 4.5 shape of text and tool_use blocks, and the tool loop never has to send
 *   thinking blocks back. A capped request with thinking on can spend its whole
 *   `max_tokens` on a thinking block and return no text.
 *
 * Other 5.x models need more before Chaude can run them: Opus 5.5 rejects disabled
 * thinking and Sonnet 5.5 turns it off with `between_tools`, so both would return
 * thinking blocks that the tool loop must pass back unmodified.
 */
export interface AnthropicModelRules {
  /** A non-default temperature is accepted */
  samplingParams: boolean
  /** A conversation may end with an assistant turn (prefill) */
  assistantPrefill: boolean
  /** Thinking setting to send with every request, when the model needs one */
  thinking?: { type: 'disabled' }
}

const DEFAULT_SAMPLING_ONLY = /^claude-(?:haiku-5|sonnet-5|opus-5|opus-4-[78]|fable-|mythos-)/
const NO_PREFILL = /^claude-(?:haiku-5|sonnet-5|opus-5|opus-4-[678]|sonnet-4-6|fable-|mythos-)/
const THINKING_OFF = /^claude-haiku-5-5(?:$|-)/

export function anthropicModelRules(model: string): AnthropicModelRules {
  return {
    samplingParams: !DEFAULT_SAMPLING_ONLY.test(model),
    assistantPrefill: !NO_PREFILL.test(model),
    ...(THINKING_OFF.test(model) ? { thinking: { type: 'disabled' as const } } : {}),
  }
}
