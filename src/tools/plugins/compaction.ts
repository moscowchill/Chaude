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
  /** Cached preview of recent conversation for selection context (updated each activation) */
  recentConversationPreview?: string
}

interface CompactionConfig {
  enabled?: boolean
  threshold_percent?: number        // Trigger at this % of rolling_threshold (default: 80)
  threshold_characters?: number     // Also trigger if context exceeds this many chars (default: 0 = disabled)
  summary_model?: string            // Model for summarization (default: claude-haiku-4-5-20251001)
  max_summaries?: number            // Max summaries to keep (default: 15)
  messages_per_summary?: number     // Messages to summarize at once (default: 25)
  // Selection options
  enable_selection?: boolean        // Enable LLM-driven selection (default: true)
  selection_model?: string          // Model for selection (default: same as summary_model)
  selection_threshold?: number      // Only select if more than N sources (default: 5)
  max_injections?: number           // Max summary sources to inject after selection (default: 5)
  max_cabinet_selections?: number   // Max note cabinets to inject after selection (default: 3)
}

const DEFAULT_CONFIG: Required<CompactionConfig> = {
  enabled: true,
  threshold_percent: 80,
  threshold_characters: 0,          // Disabled by default, set in config for safety net
  summary_model: 'claude-haiku-4-5-20251001',
  max_summaries: 15,
  messages_per_summary: 25,
  enable_selection: true,
  selection_model: 'claude-haiku-4-5-20251001',
  selection_threshold: 5,
  max_injections: 5,
  max_cabinet_selections: 3,
}

/** Note from notes plugin */
interface Note {
  id: string
  content: string
  category?: string    // Optional for backward compat with old state files
  createdAt: string
  createdByMessageId: string
}

/** Notes plugin state structure */
interface NotesState {
  notes: Note[]
  lastModifiedMessageId: string | null
}

/** A summary source that can be injected */
interface SummarySource {
  id: string
  preview: string      // Short preview for selection prompt
  content: string      // Full content for injection
  topics?: string[]
  tokenEstimate: number
  sourceMessageId?: string
}

/** A cabinet of notes grouped by category */
interface CabinetSource {
  category: string
  noteCount: number
  preview: string           // "[category] N notes: preview1; preview2..."
  notes: Note[]
  totalTokenEstimate: number
  latestMessageId?: string  // Most recent note's message ID (for injection depth)
}

/**
 * Simple token estimation (chars / 3.5)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

const plugin: ToolPlugin = {
  name: 'compaction',
  description: 'Auto-summarizes older context to reduce token usage',

  // No manual tools - this plugin works automatically
  tools: [],

  /**
   * Inject selected summaries and note cabinets into context.
   * Groups notes by category into cabinets, then uses LLM to select relevant cabinets + summaries.
   */
  getContextInjections: async (context: PluginStateContext): Promise<ContextInjection[]> => {
    const config = { ...DEFAULT_CONFIG, ...context.pluginConfig } as Required<CompactionConfig>

    if (!config.enabled) {
      return []
    }

    const scope = context.configuredScope

    // 1. Get summaries from compaction state
    const summarySources: SummarySource[] = []
    const compactionState = await context.getState<CompactionState>(scope)
    if (compactionState?.summaries.length) {
      for (const summary of compactionState.summaries) {
        summarySources.push({
          id: summary.id,
          preview: summary.summary.slice(0, 150) + (summary.summary.length > 150 ? '...' : ''),
          content: formatSummaryForInjection(summary),
          topics: summary.topics,
          tokenEstimate: summary.tokenEstimate,
          sourceMessageId: summary.messageRange.end,
        })
      }
    }

    // 2. Get notes and group into cabinets by category
    const cabinets: CabinetSource[] = []
    try {
      const notesState = await context.getPluginState<NotesState>('notes', scope)
      if (notesState?.notes.length) {
        const grouped = new Map<string, Note[]>()
        for (const note of notesState.notes) {
          const cat = note.category || 'general'
          if (!grouped.has(cat)) grouped.set(cat, [])
          grouped.get(cat)!.push(note)
        }

        for (const [category, notes] of grouped) {
          const notePreviews = notes
            .map(n => n.content.slice(0, 80) + (n.content.length > 80 ? '...' : ''))
            .join('; ')
          const preview = notePreviews.slice(0, 200) + (notePreviews.length > 200 ? '...' : '')
          const totalTokens = notes.reduce((sum, n) => sum + estimateTokens(n.content), 0)

          // Find the most recent note for injection depth aging
          const latestNote = notes.reduce((latest, n) =>
            n.createdByMessageId > (latest?.createdByMessageId || '') ? n : latest
          , notes[0]!)

          cabinets.push({
            category,
            noteCount: notes.length,
            preview: `[${category}] ${notes.length} notes: ${preview}`,
            notes,
            totalTokenEstimate: totalTokens,
            latestMessageId: latestNote.createdByMessageId,
          })
        }
      }
    } catch {
      logger.debug('Could not read notes state - notes plugin may not be loaded')
    }

    const totalSourceCount = summarySources.length + cabinets.length
    if (totalSourceCount === 0) {
      return []
    }

    // 3. Selection: pick relevant cabinets + summaries
    let selectedSummaries = summarySources
    let selectedCabinets = cabinets

    if (config.enable_selection && totalSourceCount > config.selection_threshold) {
      const recentContext = await getRecentContextPreview(context)

      const result = await selectRelevantCabinetsAndSummaries(
        context,
        summarySources,
        cabinets,
        recentContext,
        config.selection_model,
        config.max_injections,
        config.max_cabinet_selections
      )
      selectedSummaries = result.summaries
      selectedCabinets = result.cabinets

      logger.info({
        totalSummaries: summarySources.length,
        totalCabinets: cabinets.length,
        selectedSummaries: selectedSummaries.length,
        selectedCabinets: selectedCabinets.map(c => c.category),
      }, 'Selected relevant cabinets and summaries')
    } else {
      // Below threshold — cap to limits without LLM
      if (cabinets.length > config.max_cabinet_selections) {
        selectedCabinets = cabinets.slice(-config.max_cabinet_selections)
      }
      if (summarySources.length > config.max_injections) {
        selectedSummaries = summarySources.slice(-config.max_injections)
      }
    }

    // 4. Build injections
    const injections: ContextInjection[] = []

    // Cabinets: near current conversation (depth 5-7)
    let cabinetIndex = 0
    for (const cabinet of selectedCabinets) {
      injections.push({
        id: `compaction:cabinet:${cabinet.category}`,
        content: formatCabinetForInjection(cabinet),
        targetDepth: 5 + cabinetIndex++,
        priority: 80,
        lastModifiedAt: cabinet.latestMessageId || compactionState?.lastCompactionMessageId,
      })
    }

    // Summaries: deeper background context (depth 10-14)
    let summaryIndex = 0
    for (const source of selectedSummaries) {
      injections.push({
        id: `compaction:summary:${source.id}`,
        content: source.content,
        targetDepth: 10 + summaryIndex++,
        priority: 50,
        lastModifiedAt: source.sourceMessageId || compactionState?.lastCompactionMessageId,
      })
    }

    return injections
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

    // Always update the conversation preview for selection context
    // This gives the selection LLM actual conversation content to match against
    const contextMessages = result.contextMessages || []
    const scope = context.configuredScope
    const state = await context.getState<CompactionState>(scope) || {
      summaries: [],
      lastCompactionMessageId: null,
      summarizedMessageIds: [],
    }

    if (contextMessages.length > 0) {
      // Store last ~10 messages as preview (truncate each to 200 chars)
      const recentMessages = contextMessages.slice(-10)
      state.recentConversationPreview = recentMessages
        .map(m => `[${m.author}]: ${m.content.slice(0, 200)}`)
        .join('\n')

      await context.setState(scope, state)
      logger.debug({
        previewMessages: recentMessages.length,
        previewLength: state.recentConversationPreview.length,
      }, 'Updated conversation preview for selection')
    }

    // Get bot config for thresholds
    const botConfig = context.config as {
      rolling_threshold?: number
      recency_window_messages?: number
    }

    const rollingThreshold = botConfig.rolling_threshold ?? 50
    const thresholdMessages = Math.floor(rollingThreshold * (config.threshold_percent / 100))

    // Calculate total context characters for safety net check
    const totalCharacters = contextMessages.reduce((sum, m) => sum + m.content.length, 0)
    const characterThresholdExceeded = config.threshold_characters > 0 && totalCharacters >= config.threshold_characters

    // Check if we're approaching either threshold (message count OR character count)
    const messageThresholdExceeded = result.messageCount >= thresholdMessages

    if (!messageThresholdExceeded && !characterThresholdExceeded) {
      logger.debug({
        messageCount: result.messageCount,
        messageThreshold: thresholdMessages,
        totalCharacters,
        characterThreshold: config.threshold_characters,
      }, 'Below compaction thresholds')
      return
    }

    // Check if there are enough unsummarized messages before entering compaction
    const unsummarizedCount = contextMessages.filter(
      m => !state.summarizedMessageIds.includes(m.id)
    ).length
    if (unsummarizedCount < config.messages_per_summary) {
      logger.debug({
        messageCount: result.messageCount,
        unsummarized: unsummarizedCount,
        needed: config.messages_per_summary,
      }, 'Threshold exceeded but not enough unsummarized messages')
      return
    }

    logger.info({
      messageCount: result.messageCount,
      messageThreshold: thresholdMessages,
      unsummarized: unsummarizedCount,
      totalCharacters,
      characterThreshold: config.threshold_characters,
      triggeredBy: characterThresholdExceeded ? 'characters' : 'messages',
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
 * Format a cabinet of notes for context injection
 */
function formatCabinetForInjection(cabinet: CabinetSource): string {
  const lines = [
    `<notes-cabinet category="${cabinet.category}" count="${cabinet.noteCount}">`,
  ]
  for (const note of cabinet.notes) {
    lines.push(`[${note.id}] ${note.content}`)
    lines.push('')
  }
  lines.push('</notes-cabinet>')
  return lines.join('\n')
}

/**
 * Get a preview of recent context for topic detection.
 * Uses cached conversation preview from onPostActivation (one activation behind).
 */
async function getRecentContextPreview(context: PluginStateContext): Promise<string> {
  const scope = context.configuredScope
  const state = await context.getState<CompactionState>(scope)

  if (state?.recentConversationPreview) {
    return state.recentConversationPreview
  }

  // Fallback for first activation (no cached preview yet)
  return `(No conversation preview available yet - channel: ${context.channelId})`
}

/**
 * Use LLM to select relevant cabinets and summaries based on current conversation.
 * Cabinets are compact (one line per category) so the prompt stays small even with many notes.
 */
async function selectRelevantCabinetsAndSummaries(
  context: PluginStateContext,
  summaries: SummarySource[],
  cabinets: CabinetSource[],
  recentContext: string,
  model: string,
  maxSummarySelections: number,
  maxCabinetSelections: number
): Promise<{ summaries: SummarySource[]; cabinets: CabinetSource[] }> {
  if (!context.llmComplete) {
    logger.warn('LLM completion not available - falling back to most recent')
    return {
      summaries: summaries.slice(-maxSummarySelections),
      cabinets: cabinets.slice(-maxCabinetSelections),
    }
  }

  try {
    const lines: string[] = []
    let index = 1
    const indexMap: Array<{ type: 'cabinet'; idx: number } | { type: 'summary'; idx: number }> = []

    if (cabinets.length > 0) {
      lines.push('NOTE CABINETS (groups of related notes):')
      for (let i = 0; i < cabinets.length; i++) {
        lines.push(`${index}. ${cabinets[i]!.preview}`)
        indexMap.push({ type: 'cabinet', idx: i })
        index++
      }
    }

    if (summaries.length > 0) {
      lines.push('')
      lines.push('SUMMARIES (compressed earlier conversation):')
      for (let i = 0; i < summaries.length; i++) {
        const s = summaries[i]!
        const topicsStr = s.topics?.length ? ` [topics: ${s.topics.join(', ')}]` : ''
        lines.push(`${index}. ${s.preview}${topicsStr}`)
        indexMap.push({ type: 'summary', idx: i })
        index++
      }
    }

    const sourceList = lines.join('\n')

    const prompt = `You are selecting which saved context sources are most relevant to inject into an ongoing Discord conversation.

Recent conversation:
${recentContext}

Available sources (${cabinets.length} cabinets + ${summaries.length} summaries):
${sourceList}

Select up to ${maxCabinetSelections} cabinets and up to ${maxSummarySelections} summaries that are most relevant to what's being discussed.
Prioritize: cabinets about active topics/tasks > topic-relevant summaries > general background.
Always include cabinets about ongoing commitments or unresolved items if relevant.

Respond with ONLY the numbers, comma-separated. Example: 1, 3, 5
If none are relevant, respond: NONE`

    const response = await context.llmComplete({
      model,
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = response.text.trim()
    if (text === 'NONE') {
      return { summaries: [], cabinets: [] }
    }

    const selectedIndices = text
      .split(',')
      .map(s => parseInt(s.trim(), 10) - 1)
      .filter(i => !isNaN(i) && i >= 0 && i < indexMap.length)

    const resultSummaries: SummarySource[] = []
    const resultCabinets: CabinetSource[] = []

    for (const i of selectedIndices) {
      const entry = indexMap[i]!
      if (entry.type === 'cabinet' && resultCabinets.length < maxCabinetSelections) {
        resultCabinets.push(cabinets[entry.idx]!)
      } else if (entry.type === 'summary' && resultSummaries.length < maxSummarySelections) {
        resultSummaries.push(summaries[entry.idx]!)
      }
    }

    return { summaries: resultSummaries, cabinets: resultCabinets }
  } catch (error) {
    logger.error({ error, model }, 'Failed cabinet/summary selection - falling back')
    return {
      summaries: summaries.slice(-maxSummarySelections),
      cabinets: cabinets.slice(-maxCabinetSelections),
    }
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
    context,
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

  // Prune summarizedMessageIds to prevent unbounded growth
  // Keep only IDs that fall within the range of remaining summaries
  if (state.summaries.length > 0) {
    const oldestStart = state.summaries[0]!.messageRange.start
    const beforeCount = state.summarizedMessageIds.length
    state.summarizedMessageIds = state.summarizedMessageIds.filter(
      id => id >= oldestStart
    )
    if (state.summarizedMessageIds.length < beforeCount) {
      logger.debug({
        before: beforeCount,
        after: state.summarizedMessageIds.length,
      }, 'Pruned stale summarizedMessageIds')
    }
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

/** Expected JSON response from summarization LLM */
interface SummaryResponse {
  summary: string
  topics: string[]
}

/**
 * Create a summary using the LLM with actual message content.
 * Uses the framework's LLM middleware for provider-agnostic completions.
 * Returns JSON for robust parsing.
 */
async function createSummary(
  context: PluginStateContext,
  messages: MessageToSummarize[],
  model: string,
  channelId: string
): Promise<Summary | null> {
  // Fallback if LLM completion not available
  if (!context.llmComplete) {
    logger.warn('LLM completion not available - cannot create summary')
    return null
  }

  try {
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

Respond with a single JSON object with two keys:
- "summary": a string containing your concise summary (aim for 100-200 words)
- "topics": an array of 3-5 topic keyword strings

Example response:
{"summary": "The team discussed...", "topics": ["authentication", "api", "testing"]}`

    const response = await context.llmComplete({
      model,
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = response.text.trim()

    // Parse JSON response
    let parsed: SummaryResponse
    try {
      // Handle potential markdown code blocks wrapping JSON
      const jsonStr = text.replace(/^```json?\s*|\s*```$/g, '').trim()
      parsed = JSON.parse(jsonStr)
    } catch (parseError) {
      logger.error({ parseError, text }, 'Failed to parse JSON response from LLM - using fallback')
      // Fallback: try to extract content from malformed response
      parsed = {
        summary: `Summary of ${messages.length} messages`,
        topics: ['conversation'],
      }
    }

    const summaryText = parsed.summary || `Summary of ${messages.length} messages`
    const topics = Array.isArray(parsed.topics) && parsed.topics.length > 0
      ? parsed.topics
      : ['conversation']

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
