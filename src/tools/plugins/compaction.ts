/**
 * Compaction Plugin
 *
 * Auto-summarizes older context to reduce token usage.
 * Runs in background after activation via onPostActivation hook.
 *
 * Features:
 * - Summarizes older messages when context approaches threshold
 * - Extracts topic keywords for intelligent retrieval
 * - Injects summaries into context for continuity
 */

import Anthropic from '@anthropic-ai/sdk'
import { ToolPlugin, PluginStateContext, ContextInjection, ActivationResult } from './types.js'
import { logger } from '../../utils/logger.js'

interface Summary {
  id: string
  messageRange: {
    start: string  // Oldest message ID in range
    end: string    // Newest message ID in range
  }
  summary: string
  topics: string[]
  createdAt: string
  tokenEstimate: number
}

interface CompactionState {
  summaries: Summary[]
  lastCompactionMessageId: string | null
  /** Message IDs that have been summarized (to avoid re-summarizing) */
  summarizedMessageIds: string[]
}

interface CompactionConfig {
  enabled?: boolean
  threshold_percent?: number        // Trigger at this % of rolling_threshold (default: 80)
  summary_model?: string            // Model for summarization (default: claude-haiku-4-5-20251001)
  max_summaries?: number            // Max summaries to keep (default: 15)
  messages_per_summary?: number     // Messages to summarize at once (default: 25)
  // Selection options
  enable_selection?: boolean        // Enable LLM-driven selection (default: true)
  selection_model?: string          // Model for selection (default: same as summary_model)
  selection_threshold?: number      // Only select if more than N sources (default: 5)
  max_injections?: number           // Max sources to inject after selection (default: 5)
}

const DEFAULT_CONFIG: Required<CompactionConfig> = {
  enabled: true,
  threshold_percent: 80,
  summary_model: 'claude-haiku-4-5-20251001',
  max_summaries: 15,
  messages_per_summary: 25,
  enable_selection: true,
  selection_model: 'claude-haiku-4-5-20251001',
  selection_threshold: 5,
  max_injections: 5,
}

/** Note from notes plugin */
interface Note {
  id: string
  content: string
  createdAt: string
  createdByMessageId: string
}

/** Notes plugin state structure */
interface NotesState {
  notes: Note[]
  lastModifiedMessageId: string | null
}

/** A source that can be injected (note or summary) */
interface ContextSource {
  type: 'note' | 'summary'
  id: string
  preview: string      // Short preview for selection prompt
  content: string      // Full content for injection
  topics?: string[]    // Topics (summaries only)
  tokenEstimate: number
}

/**
 * Simple token estimation (chars / 3.5)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

/**
 * Create Anthropic client (uses ANTHROPIC_API_KEY from env)
 */
function getAnthropicClient(): Anthropic {
  return new Anthropic()
}

const plugin: ToolPlugin = {
  name: 'compaction',
  description: 'Auto-summarizes older context to reduce token usage',

  // No manual tools - this plugin works automatically
  tools: [],

  /**
   * Inject selected summaries and notes into context.
   * Uses LLM-driven selection when there are many sources.
   */
  getContextInjections: async (context: PluginStateContext): Promise<ContextInjection[]> => {
    const config = { ...DEFAULT_CONFIG, ...context.pluginConfig } as Required<CompactionConfig>

    if (!config.enabled) {
      return []
    }

    const scope = context.configuredScope

    // Gather all context sources
    const sources: ContextSource[] = []

    // 1. Get summaries from compaction state
    const compactionState = await context.getState<CompactionState>(scope)
    if (compactionState?.summaries.length) {
      for (const summary of compactionState.summaries) {
        sources.push({
          type: 'summary',
          id: summary.id,
          preview: summary.summary.slice(0, 150) + (summary.summary.length > 150 ? '...' : ''),
          content: formatSummaryForInjection(summary),
          topics: summary.topics,
          tokenEstimate: summary.tokenEstimate,
        })
      }
    }

    // 2. Get notes from notes plugin state (if available)
    // We read notes plugin state directly to enable unified selection
    try {
      const notesState = await context.getState<NotesState>(scope)
      if (notesState?.notes.length) {
        for (const note of notesState.notes) {
          sources.push({
            type: 'note',
            id: note.id,
            preview: note.content.slice(0, 150) + (note.content.length > 150 ? '...' : ''),
            content: formatNoteForInjection(note),
            tokenEstimate: estimateTokens(note.content),
          })
        }
      }
    } catch {
      // Notes plugin may not be loaded - that's fine
      logger.debug('Could not read notes state - notes plugin may not be loaded')
    }

    if (sources.length === 0) {
      return []
    }

    // 3. If below threshold or selection disabled, inject all (up to max)
    let selectedSources = sources

    if (config.enable_selection && sources.length > config.selection_threshold) {
      // Get recent messages for topic context
      const recentContext = getRecentContextPreview(context)

      // Call LLM to select relevant sources
      selectedSources = await selectRelevantSources(
        sources,
        recentContext,
        config.selection_model,
        config.max_injections
      )

      logger.info({
        totalSources: sources.length,
        selectedCount: selectedSources.length,
        selectedIds: selectedSources.map(s => s.id),
      }, 'Selected relevant context sources')
    } else if (sources.length > config.max_injections) {
      // No selection but too many - take most recent
      selectedSources = sources.slice(-config.max_injections)
    }

    // 4. Build injections from selected sources
    // Notes get higher priority than summaries
    return selectedSources.map((source, index) => ({
      id: `compaction:${source.type}:${source.id}`,
      content: source.content,
      targetDepth: -5 - index,
      priority: source.type === 'note' ? 80 : 50,
      lastModifiedAt: compactionState?.lastCompactionMessageId,
    }))
  },

  /**
   * Run compaction check after activation completes (in background)
   */
  onPostActivation: async (
    context: PluginStateContext,
    result: ActivationResult
  ): Promise<void> => {
    const config = { ...DEFAULT_CONFIG, ...context.pluginConfig } as Required<CompactionConfig>

    if (!config.enabled) {
      return
    }

    // Skip if activation failed
    if (!result.success) {
      logger.debug('Skipping compaction - activation failed')
      return
    }

    // Get bot config for thresholds
    const botConfig = context.config as {
      rolling_threshold?: number
      recency_window_messages?: number
    }

    const rollingThreshold = botConfig.rolling_threshold ?? 50
    const thresholdMessages = Math.floor(rollingThreshold * (config.threshold_percent / 100))

    // Check if we're approaching threshold
    if (result.messageCount < thresholdMessages) {
      logger.debug({
        messageCount: result.messageCount,
        threshold: thresholdMessages,
      }, 'Below compaction threshold')
      return
    }

    logger.info({
      messageCount: result.messageCount,
      threshold: thresholdMessages,
      channelId: result.channelId,
    }, 'Compaction threshold reached - starting summarization')

    try {
      await runCompaction(context, config, result)
    } catch (error) {
      logger.error({ error, channelId: result.channelId }, 'Compaction failed')
    }
  },
}

/**
 * Format a summary for context injection
 */
function formatSummaryForInjection(summary: Summary): string {
  const topicsStr = summary.topics.length > 0
    ? ` (topics: ${summary.topics.join(', ')})`
    : ''

  return [
    `<earlier-context id="${summary.id}"${topicsStr}>`,
    summary.summary,
    '</earlier-context>',
  ].join('\n')
}

/**
 * Format a note for context injection
 */
function formatNoteForInjection(note: Note): string {
  return [
    `<note id="${note.id}">`,
    note.content,
    '</note>',
  ].join('\n')
}

/**
 * Get a preview of recent context for topic detection
 */
function getRecentContextPreview(context: PluginStateContext): string {
  // Use the last few message IDs from context to give the LLM topic hints
  // We don't have message content here, but we have the triggering message context
  const messageIds = Array.from(context.contextMessageIds).slice(-5)
  return `Recent message IDs: ${messageIds.join(', ')} (channel: ${context.channelId})`
}

/**
 * Use LLM to select relevant sources based on current topic
 */
async function selectRelevantSources(
  sources: ContextSource[],
  recentContext: string,
  model: string,
  maxSelections: number
): Promise<ContextSource[]> {
  try {
    const client = getAnthropicClient()

    // Build source list for selection
    const sourceList = sources.map((s, i) => {
      const topicsStr = s.topics?.length ? ` [topics: ${s.topics.join(', ')}]` : ''
      return `${i + 1}. [${s.type}] ${s.preview}${topicsStr}`
    }).join('\n')

    const prompt = `You are selecting which context sources are most relevant to inject into an ongoing conversation.

Current context: ${recentContext}

Available sources (${sources.length} total):
${sourceList}

Select up to ${maxSelections} sources that would be most relevant and useful for the current conversation.
Consider:
- Topic relevance to recent discussion
- Important decisions or facts that should be remembered
- Ongoing tasks or commitments

Respond with ONLY the numbers of the sources to include, comma-separated.
Example: 1, 3, 5

If none are relevant, respond with: NONE`

    const response = await client.messages.create({
      model,
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim()

    if (text === 'NONE') {
      return []
    }

    // Parse selected indices
    const selectedIndices = text
      .split(',')
      .map(s => parseInt(s.trim(), 10) - 1)  // Convert to 0-indexed
      .filter(i => !isNaN(i) && i >= 0 && i < sources.length)

    // Return selected sources
    return selectedIndices.map(i => sources[i]!)
  } catch (error) {
    logger.error({ error, model }, 'Failed to select relevant sources - falling back to all')
    // On error, return most recent sources up to max
    return sources.slice(-maxSelections)
  }
}

/**
 * Run the compaction process
 */
async function runCompaction(
  context: PluginStateContext,
  config: Required<CompactionConfig>,
  result: ActivationResult
): Promise<void> {
  const scope = context.configuredScope
  const state = await context.getState<CompactionState>(scope) || {
    summaries: [],
    lastCompactionMessageId: null,
    summarizedMessageIds: [],
  }

  // Get messages from activation result that haven't been summarized
  const contextMessages = result.contextMessages || []
  const unsummarizedMessages = contextMessages.filter(
    m => !state.summarizedMessageIds.includes(m.id)
  )

  // Need enough messages to summarize
  if (unsummarizedMessages.length < config.messages_per_summary) {
    logger.debug({
      unsummarized: unsummarizedMessages.length,
      needed: config.messages_per_summary,
    }, 'Not enough unsummarized messages')
    return
  }

  // Take the oldest N messages to summarize (they're ordered newest-first)
  const messagesToSummarize = unsummarizedMessages.slice(-config.messages_per_summary)

  logger.info({
    messageCount: messagesToSummarize.length,
    channelId: result.channelId,
  }, 'Summarizing messages')

  // Call LLM for summarization with actual message content
  const summary = await createSummary(
    messagesToSummarize,
    config.summary_model,
    result.channelId
  )

  if (!summary) {
    logger.warn('Failed to create summary')
    return
  }

  // Add to state
  state.summaries.push(summary)
  state.lastCompactionMessageId = result.triggeringMessageId || null
  state.summarizedMessageIds.push(...messagesToSummarize.map(m => m.id))

  // Prune old summaries if we have too many
  while (state.summaries.length > config.max_summaries) {
    const removed = state.summaries.shift()
    logger.debug({ removedId: removed?.id }, 'Pruned old summary')
  }

  await context.setState(scope, state)

  logger.info({
    summaryId: summary.id,
    topics: summary.topics,
    tokenEstimate: summary.tokenEstimate,
    totalSummaries: state.summaries.length,
    channelId: result.channelId,
  }, 'Created context summary')
}

interface MessageToSummarize {
  id: string
  author: string
  content: string
  timestamp: string
}

/**
 * Create a summary using the LLM with actual message content
 */
async function createSummary(
  messages: MessageToSummarize[],
  model: string,
  channelId: string
): Promise<Summary | null> {
  try {
    const client = getAnthropicClient()

    // Format messages for summarization
    const formattedMessages = messages
      .map(m => `[${m.author}]: ${m.content}`)
      .join('\n')

    const prompt = `You are summarizing a conversation segment for context compaction. The goal is to preserve key information in a compact form.

Conversation (${messages.length} messages from channel ${channelId}):

${formattedMessages}

Create a concise summary that preserves:
- Key decisions made
- Important facts or information learned
- Ongoing tasks or commitments
- Main discussion topics

Also extract 3-5 topic keywords that describe what was discussed.

Respond in this exact format:
SUMMARY: [Your concise summary here - aim for 100-200 words]
TOPICS: topic1, topic2, topic3`

    const response = await client.messages.create({
      model,
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('')

    // Parse response
    const summaryMatch = text.match(/SUMMARY:\s*(.+?)(?=TOPICS:|$)/s)
    const topicsMatch = text.match(/TOPICS:\s*(.+)/s)

    const summaryText = summaryMatch?.[1]?.trim() || `Summary of ${messages.length} messages`
    const topics = topicsMatch?.[1]?.split(',').map(t => t.trim()).filter(Boolean) || ['conversation']

    return {
      id: `summary_${Date.now().toString(36)}`,
      messageRange: {
        start: messages[0]?.id || '',
        end: messages[messages.length - 1]?.id || '',
      },
      summary: summaryText,
      topics,
      createdAt: new Date().toISOString(),
      tokenEstimate: estimateTokens(summaryText),
    }
  } catch (error) {
    logger.error({ error, model }, 'Failed to call LLM for summarization')
    return null
  }
}

export default plugin
