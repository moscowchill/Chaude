/**
 * Anthropic Provider
 */

import Anthropic from '@anthropic-ai/sdk'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { LLMProvider, ProviderRequest, ProviderMessage, AnthropicContentBlock } from '../middleware.js'
import { LLMCompletion, ContentBlock, LLMError, TextContent } from '../../types.js'
import { logger } from '../../utils/logger.js'
import { getCurrentTrace } from '../../trace/index.js'
import { processRequestForLogging } from '../../utils/blob-store.js'
import { anthropicModelRules, thinkingParam } from './anthropic-models.js'

/** Beta header for `fallbacks: 'default'`: a refused request is answered by a fallback model */
const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01'

// Extended usage type to include cache tokens (not in base Anthropic types)
interface AnthropicUsageWithCache {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic'
  readonly supportedModes: ('prefill' | 'chat')[] = ['prefill', 'chat']

  private client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 0, timeout: 120_000 })
  }

  /** Whether the model accepts an assistant prefill (the middleware refuses prefill mode otherwise) */
  supportsPrefill(model: string): boolean {
    return anthropicModelRules(model).assistantPrefill
  }

  /**
   * The non-system turns to send. Models that reject an assistant prefill get the
   * conversation up to its last user turn. In chat mode the conversation ends on an
   * assistant turn when the bot's own message is the newest one, when the triggering
   * message has no text or image left after filtering, or for a queued second activation
   * after the first reply was posted. Older models continued the bot's turn as a
   * prefill; these models answer the last user turn again.
   */
  private conversation(model: string, messages: ProviderMessage[], warn = false): ProviderMessage[] {
    const turns = messages.filter((m) => m.role !== 'system')
    if (anthropicModelRules(model).assistantPrefill) return turns
    let end = turns.length
    while (end > 0 && turns[end - 1]?.role === 'assistant') end--
    if (end === 0) {
      throw new LLMError(`Nothing to answer: ${model} needs the conversation to end with a user turn`)
    }
    if (warn && end < turns.length) {
      logger.warn({ model, dropped: turns.length - end }, 'Dropped trailing assistant turns: this model rejects assistant prefill')
    }
    return turns.slice(0, end)
  }

  async countInputTokens(request: ProviderRequest): Promise<number> {
    const system = request.messages.filter(m => m.role === 'system').flatMap(m =>
      typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content)
    const params = {
      model: request.model,
      system: system.length ? system : undefined,
      messages: this.conversation(request.model, request.messages),
      tools: request.tools?.length ? request.tools : undefined,
      thinking: thinkingParam(anthropicModelRules(request.model), request.thinking),
    }
    const count = await this.client.messages.countTokens(
      params as unknown as Anthropic.MessageCountTokensParams
    )
    return count.input_tokens
  }

  /**
   * Send a request, always streamed and collected into the final message. The client
   * timeout only covers the wait for response headers, so a long reply (thinking
   * included) can't be cut off mid-generation. Beta features go to the beta endpoint.
   */
  private async send(params: Record<string, unknown>, betas: string[]): Promise<Anthropic.Message> {
    if (betas.length > 0) {
      const body = { ...params, betas } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming
      return (await this.client.beta.messages.stream(body).finalMessage()) as unknown as Anthropic.Message
    }
    const body = params as unknown as Anthropic.MessageCreateParamsNonStreaming
    return await this.client.messages.stream(body).finalMessage()
  }

  async complete(request: ProviderRequest): Promise<LLMCompletion> {
    // Before the trace call starts: a conversation with nothing to answer throws here
    // and leaves no unfinished LLM call in the trace
    const nonSystemMessages = this.conversation(request.model, request.messages, true)
    const trace = getCurrentTrace()
    const callId = trace?.startLLMCall(trace.getLLMCallCount())
    const startTime = Date.now()

      // Extract system messages - preserve cache_control if present
      const systemMsgs = request.messages.filter((m) => m.role === 'system')
      let systemParam: string | AnthropicContentBlock[] | undefined
      
      if (systemMsgs.length > 0) {
        // Check if any system message has cache_control (array format)
        const hasArrayContent = systemMsgs.some(m => Array.isArray(m.content))
        
        if (hasArrayContent) {
          // Use array format to preserve cache_control
          systemParam = systemMsgs.flatMap(m => {
            if (Array.isArray(m.content)) return m.content
            return [{ type: 'text', text: m.content }]
          })
        } else {
          // Simple string format
          systemParam = systemMsgs
            .map(m => typeof m.content === 'string' ? m.content : '')
        .join('\n\n')
        }
      }

      const rules = anthropicModelRules(request.model)

      // Build request params (some models don't support both temperature and top_p)
      const params: Record<string, unknown> = {
        model: request.model,
        max_tokens: request.max_tokens,
        system: systemParam,
        messages: nonSystemMessages,
        stop_sequences: request.stop_sequences,
      }

      // Only include temperature (not top_p) to avoid API errors with newer models.
      // Models that accept only the default sampling get no temperature at all.
      const temperature = rules.samplingParams ? request.temperature : undefined
      if (temperature !== undefined) {
        params.temperature = temperature
      }
      const thinking = thinkingParam(rules, request.thinking)
      if (thinking) {
        params.thinking = thinking
      }
      if (request.effort && rules.adaptiveThinking) {
        params.output_config = { effort: request.effort }
      }
      // Where available, a server-side fallback model answers a request that a safety
      // classifier declines (routed by refusal category)
      const betas = rules.serverFallback ? [SERVER_FALLBACK_BETA] : []
      if (rules.serverFallback) {
        params.fallbacks = 'default'
      }

      // Add tools if provided
      if (request.tools && request.tools.length > 0) {
        params.tools = request.tools
      }

    // Log request to file BEFORE making the call (so we have it even on error)
    const requestRef = this.logRequestToFile(betas.length > 0 ? { ...params, betas } : params)
    
    try {
      logger.debug({ model: request.model, traceId: trace?.getTraceId() }, 'Calling Anthropic API')

      const response = await this.send(params, betas)

      // Log response to file (and get ref for trace)
      const responseRef = this.logResponseToFile(response)

      const durationMs = Date.now() - startTime

      logger.debug({ 
        stopReason: response.stop_reason,
        contentBlocks: response.content.length,
        firstBlock: response.content[0]?.type,
        durationMs,
      }, 'Received Anthropic response')

      // Parse response
      const content: ContentBlock[] = response.content.flatMap((block): ContentBlock[] => {
        if (block.type === 'text') {
          return [{ type: 'text' as const, text: block.text }]
        } else if (block.type === 'tool_use') {
          return [{
            type: 'tool_use' as const,
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          }]
        }
        // Reasoning blocks stay verbatim (signature included, text often empty): a tool
        // continuation must send them back unmodified. Every reader of the reply takes
        // only text blocks, so they never reach Discord.
        if (block.type === 'thinking') {
          return [{ type: 'thinking' as const, thinking: block.thinking, signature: block.signature }]
        }
        if (block.type === 'redacted_thinking') {
          return [{ type: 'redacted_thinking' as const, data: block.data }]
        }
        // Unknown block type, return as text
        return [{ type: 'text' as const, text: JSON.stringify(block) }]
      })

      // Calculate text length for trace
      const textLength = content
        .filter((c): c is TextContent => c.type === 'text')
        .reduce((sum, c) => sum + (c.text?.length || 0), 0)
      const toolUseCount = content.filter(c => c.type === 'tool_use').length

      // Record to trace
      if (trace && callId) {
        trace.completeLLMCall(
          callId,
          {
            messageCount: request.messages.length,
            systemPromptLength: Array.isArray(systemParam) ? systemParam.length : (systemParam?.length || 0),
            hasTools: !!(request.tools && request.tools.length > 0),
            toolCount: request.tools?.length || 0,
            temperature,
            maxTokens: request.max_tokens,
            stopSequences: request.stop_sequences,
            apiBaseUrl: 'https://api.anthropic.com',
          },
          {
            stopReason: this.mapStopReason(response.stop_reason),
            contentBlocks: response.content.length,
            textLength,
            toolUseCount,
          },
          {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            cacheCreationTokens: (response.usage as AnthropicUsageWithCache).cache_creation_input_tokens,
            cacheReadTokens: (response.usage as AnthropicUsageWithCache).cache_read_input_tokens,
          },
          response.model,
          {
            requestBodyRef: requestRef,
            responseBodyRef: responseRef,
          }
        )
      }

      return {
        content,
        stopReason: this.mapStopReason(response.stop_reason),
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheCreationTokens: (response.usage as AnthropicUsageWithCache).cache_creation_input_tokens,
          cacheReadTokens: (response.usage as AnthropicUsageWithCache).cache_read_input_tokens,
        },
        model: response.model,
        raw: response,
      }
    } catch (error: unknown) {
      // Record error to trace (request body was already logged above)
      if (trace && callId) {
        trace.failLLMCall(callId, {
          message: error instanceof Error ? error.message : String(error),
          retryCount: 0,
        }, {
          requestBodyRef: requestRef,
          model: request.model,
          request: {
            messageCount: request.messages.length,
            systemPromptLength: Array.isArray(systemParam) ? systemParam.length : (systemParam?.length || 0),
            hasTools: !!(request.tools && request.tools.length > 0),
            toolCount: request.tools?.length || 0,
            temperature,
            maxTokens: request.max_tokens,
            stopSequences: request.stop_sequences,
            apiBaseUrl: 'https://api.anthropic.com',
          },
        })
      }
      logger.error({ error }, 'Anthropic API error')
      throw new LLMError('Anthropic API call failed', error)
    }
  }

  private mapStopReason(reason: string | null): 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'refusal' {
    // Handle null/undefined
    if (!reason) {
      return 'end_turn'
    }
    
    // Check for refusal (case-insensitive, may appear as 'refusal', 'content_filter', etc.)
    const lowerReason = reason.toLowerCase()
    if (lowerReason.includes('refusal') || lowerReason.includes('refuse') || lowerReason.includes('content_filter')) {
      return 'refusal'
    }
    
    switch (reason) {
      case 'end_turn':
        return 'end_turn'
      case 'max_tokens':
        return 'max_tokens'
      case 'stop_sequence':
        return 'stop_sequence'
      case 'tool_use':
        return 'tool_use'
      default:
        return 'end_turn'
    }
  }

  private logRequestToFile(params: Record<string, unknown>): string | undefined {
    try {
      const dir = join(process.cwd(), 'logs', 'llm-requests')
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const basename = `request-${timestamp}.json`
      const filename = join(dir, basename)

      // Extract images to blob store before logging
      const processedParams = processRequestForLogging(params)
      
      writeFileSync(filename, JSON.stringify(processedParams, null, 2))
      logger.debug({ filename }, 'Logged request to file')
      return basename
    } catch (error: unknown) {
      logger.warn({ error }, 'Failed to log request to file')
      return undefined
    }
  }

  private logResponseToFile(response: unknown): string | undefined {
    try {
      const dir = join(process.cwd(), 'logs', 'llm-responses')
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const basename = `response-${timestamp}.json`
      const filename = join(dir, basename)

      writeFileSync(filename, JSON.stringify(response, null, 2))
      logger.debug({ filename }, 'Logged response to file')
      return basename
    } catch (error: unknown) {
      logger.warn({ error }, 'Failed to log response to file')
      return undefined
    }
  }
}

