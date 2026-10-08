/**
 * Tests for the notes + compaction memory system:
 * - compaction must summarize the OLDEST messages (the ones about to roll off)
 * - notes consolidation runs opportunistically (cooldown-gated, no hour gate),
 *   backs up pre-consolidation state, and keeps originals on bad LLM output
 * - notes injection defers to compaction's cabinet injection when both are active
 *
 * Run with: npm test -- plugins
 */

import { describe, it, expect } from 'vitest'
import notesPlugin from './notes.js'
import compactionPlugin, { parseSelection } from './compaction.js'
import type { PluginStateContext, ActivationResult, PluginLLMRequest, PluginLLMResponse } from './types.js'

interface FakeContextOptions {
  pluginConfig?: Record<string, unknown>
  botConfig?: Record<string, unknown>
  initialState?: Record<string, unknown>
  otherPluginState?: Record<string, unknown>
  llmResponse?: string | ((req: PluginLLMRequest) => string)
  llmStopReason?: PluginLLMResponse['stopReason']
}

function makeContext(opts: FakeContextOptions = {}) {
  const store = new Map<string, unknown>()
  if (opts.initialState) {
    store.set('channel', opts.initialState)
  }
  const llmCalls: PluginLLMRequest[] = []

  const context = {
    botId: 'TestBot',
    channelId: 'chan1',
    guildId: 'guild1',
    currentMessageId: 'msg-current',
    config: opts.botConfig || {},
    pluginConfig: opts.pluginConfig,
    sendMessage: async () => [],
    pinMessage: async () => {},
    getState: async <T,>(scope: string): Promise<T | null> => (store.get(scope) as T) ?? null,
    setState: async <T,>(scope: string, state: T): Promise<void> => {
      store.set(scope, state)
    },
    getStateAtMessage: async () => null,
    contextMessageIds: new Set<string>(),
    messagesSinceId: () => 0,
    configuredScope: 'channel' as const,
    getPluginState: async <T,>(): Promise<T | null> => (opts.otherPluginState as T) ?? null,
    llmComplete: opts.llmResponse
      ? async (req: PluginLLMRequest): Promise<PluginLLMResponse> => {
          llmCalls.push(req)
          const text = typeof opts.llmResponse === 'function' ? opts.llmResponse(req) : opts.llmResponse!
          return { text, stopReason: opts.llmStopReason ?? 'end_turn' }
        }
      : undefined,
  } as unknown as PluginStateContext

  return { context, store, llmCalls }
}

function makeActivationResult(contextMessages: Array<{ id: string; author: string; content: string; timestamp: string }>): ActivationResult {
  return {
    success: true,
    channelId: 'chan1',
    guildId: 'guild1',
    triggeringMessageId: 'msg-current',
    messageCount: contextMessages.length,
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
    toolCallCount: 0,
    sentMessageIds: [],
    contextMessages,
  } as ActivationResult
}

function makeNote(id: string, content: string, category: string, createdByMessageId: string) {
  return { id, content, category, createdAt: '2026-06-01T00:00:00.000Z', createdByMessageId }
}

describe('compaction summarization direction', () => {
  it('summarizes the OLDEST unsummarized messages, not the newest', async () => {
    const { context, store, llmCalls } = makeContext({
      pluginConfig: { enabled: true, threshold_percent: 50, messages_per_summary: 5 },
      botConfig: { rolling_threshold: 10 },
      llmResponse: '{"summary":"the summary","topics":["topic"]}',
    })

    // 8 messages, oldest first (matching connector ordering)
    const messages = Array.from({ length: 8 }, (_, i) => ({
      id: `m${i + 1}`,
      author: 'alice',
      content: `message-number-${i + 1}`,
      timestamp: '2026-06-01T00:00:00.000Z',
    }))

    await compactionPlugin.onPostActivation!(context, makeActivationResult(messages))

    // The summarization prompt must contain the oldest messages and exclude the newest
    const summarizeCall = llmCalls.find(c => JSON.stringify(c.messages).includes('message-number-1'))
    expect(summarizeCall, 'expected a summarization call covering the oldest message').toBeDefined()
    const prompt = JSON.stringify(summarizeCall!.messages)
    expect(prompt).toContain('message-number-1')
    expect(prompt).toContain('message-number-5')
    expect(prompt).not.toContain('message-number-8')
    expect(summarizeCall!.max_tokens).toBe(1024)

    // State marks exactly the oldest 5 as summarized
    const state = store.get('channel') as { summaries: unknown[]; summarizedMessageIds: string[] }
    expect(state.summaries).toHaveLength(1)
    expect(state.summarizedMessageIds).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
  })
})

describe('compaction source selection', () => {
  it('asks for structured output and uses the numbers it returns', async () => {
    // Free text let Haiku 5.5 explain its choice in prose and the parser picked stray
    // numbers out of it; the schema forces {"selected": [...]}
    const summaries = Array.from({ length: 6 }, (_, i) => ({
      id: `s${i}`,
      messageRange: { start: `a${i}`, end: `b${i}` },
      summary: `summary number ${i}`,
      topics: ['topic'],
      createdAt: '2026-06-01T00:00:00.000Z',
      tokenEstimate: 10,
    }))
    const { context, llmCalls } = makeContext({
      pluginConfig: { enabled: true, enable_selection: true, selection_threshold: 5 },
      initialState: { summaries, lastCompactionMessageId: null, summarizedMessageIds: [] },
      llmResponse: '{"selected": [2, 4]}',
    })

    const injections = await compactionPlugin.getContextInjections!(context)

    const selection = llmCalls.find(c => JSON.stringify(c.messages).includes('selected'))
    expect(selection).toMatchObject({ max_tokens: 1024 })
    expect(selection?.outputSchema).toMatchObject({ required: ['selected'] })
    expect(selection?.thinking).toBeUndefined()
    expect(JSON.stringify(injections)).toContain('summary number 1')
    expect(JSON.stringify(injections)).toContain('summary number 3')
    expect(JSON.stringify(injections)).not.toContain('summary number 5')
  })
})

describe('compaction selection replies', () => {
  it.each([
    ['structured output', '{"selected": [2, 7]}', [2, 7]],
    ['an empty structured pick', '{"selected": []}', 'none'],
    ['JSON in a code fence', '```json\n{"selected": [2, 7]}\n```', [2, 7]],
    ['JSON after a sentence', 'Picks: {"selected": [3]}', [3]],
    ['a pick list without numbers', '{"selected": ["two"]}', []],
    ['older comma text', '2, 7', [2, 7]],
    ['prose with commas', 'Message 7 mentions it, 3 days ago', []],
    ['a string where the list goes', '{"selected": "2, 4"}', []],
    ['braces before the JSON', 'Context {greeting} then {"selected": [3]}', [3]],
    ['duplicate picks', '{"selected": [2, 2, 4]}', [2, 4]],
    ['duplicate older text', '2, 2, 4', [2, 4]],
    ['older NONE', 'NONE', 'none'],
    ['prose', 'The latest message is a greeting, so nothing applies.', []],
  ])('parses %s', (_case, text, expected) => {
    expect(parseSelection(text)).toEqual(expected)
  })
})

describe('compaction source selection fallback', () => {
  const summaries = Array.from({ length: 6 }, (_, i) => ({
    id: `s${i}`,
    messageRange: { start: `a${i}`, end: `b${i}` },
    summary: `summary number ${i}`,
    topics: ['topic'],
    createdAt: '2026-06-01T00:00:00.000Z',
    tokenEstimate: 10,
  }))
  it.each([
    ['a wordy reply', 'The latest message is a greeting, so nothing applies here.', 'end_turn' as const],
    ['a reply cut off at max_tokens', '2, 4', 'max_tokens' as const],
  ])('falls back to the most recent sources on %s instead of selecting nothing', async (_case, reply, stopReason) => {
    const { context } = makeContext({
      pluginConfig: { enabled: true, enable_selection: true, selection_threshold: 5, max_injections: 2 },
      initialState: { summaries, lastCompactionMessageId: null, summarizedMessageIds: [] },
      llmResponse: reply,
      llmStopReason: stopReason,
    })
    const injected = JSON.stringify(await compactionPlugin.getContextInjections!(context))
    expect(injected).toContain('summary number 5')
    expect(injected).toContain('summary number 4')
    expect(injected).not.toContain('summary number 1')
  })
})

describe('notes consolidation', () => {
  const sixNotes = Array.from({ length: 6 }, (_, i) =>
    makeNote(`note_${i}`, `note content ${i}`, 'tasks', `msg-${i + 100}`)
  )

  it('runs opportunistically (no UTC-hour gate) and writes a pre-consolidation backup', async () => {
    const { context, store } = makeContext({
      pluginConfig: { consolidation_enabled: true, min_notes_to_consolidate: 5, consolidation_cooldown_hours: 24 },
      initialState: { notes: [...sixNotes], lastModifiedMessageId: null },
      llmResponse: '[{"content":"merged note","category":"tasks"}]',
    })

    await notesPlugin.onPostActivation!(context, makeActivationResult([]))

    const state = store.get('channel') as {
      notes: Array<{ content: string; createdByMessageId: string }>
      lastConsolidationAt?: string
      preConsolidationBackup?: { notes: unknown[] }
    }
    expect(state.notes).toHaveLength(1)
    expect(state.notes[0]!.content).toBe('merged note')
    // Aging stamp: newest SOURCE note's message ID, not the current message
    expect(state.notes[0]!.createdByMessageId).toBe('msg-105')
    expect(state.lastConsolidationAt).toBeDefined()
    expect(state.preConsolidationBackup?.notes).toHaveLength(6)
  })

  it('respects the cooldown', async () => {
    const { context, store, llmCalls } = makeContext({
      pluginConfig: { consolidation_enabled: true, min_notes_to_consolidate: 5, consolidation_cooldown_hours: 24 },
      initialState: {
        notes: [...sixNotes],
        lastModifiedMessageId: null,
        lastConsolidationAt: new Date().toISOString(),
      },
      llmResponse: '[{"content":"merged note","category":"tasks"}]',
    })

    await notesPlugin.onPostActivation!(context, makeActivationResult([]))

    expect(llmCalls).toHaveLength(0)
    const state = store.get('channel') as { notes: unknown[] }
    expect(state.notes).toHaveLength(6)
  })

  it('asks Claude Opus 5.5 with room for thinking and the full JSON', async () => {
    const { context, llmCalls } = makeContext({
      pluginConfig: { consolidation_enabled: true, min_notes_to_consolidate: 5 },
      initialState: { notes: [...sixNotes], lastModifiedMessageId: null },
      llmResponse: '[{"content":"merged note","category":"tasks"}]',
    })

    await notesPlugin.onPostActivation!(context, makeActivationResult([]))

    expect(llmCalls).toHaveLength(1)
    expect(llmCalls[0]).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 32_000, effort: 'medium' })
  })

  it('keeps originals when the reply was cut off at max_tokens, without parsing it', async () => {
    // Every production consolidation on the old 4096 cap ended this way: valid JSON up
    // to the cut. A reply that happens to parse must still be refused.
    const { context, store } = makeContext({
      pluginConfig: { consolidation_enabled: true, min_notes_to_consolidate: 5 },
      initialState: { notes: [...sixNotes], lastModifiedMessageId: null },
      llmResponse: '[{"content":"merged note","category":"tasks"}]',
      llmStopReason: 'max_tokens',
    })

    await notesPlugin.onPostActivation!(context, makeActivationResult([]))

    const state = store.get('channel') as { notes: unknown[]; preConsolidationBackup?: unknown }
    expect(state.notes).toHaveLength(6)
    expect(state.preConsolidationBackup).toBeUndefined()
  })

  it.each([
    ['a reply cut off at max_tokens', 'max_tokens' as const, '[{"content":"merged","category":"tasks"}]'],
    ['an unparseable reply', 'end_turn' as const, 'sorry, I cannot do that'],
  ])('waits out the cooldown after %s instead of retrying on the next activation', async (_case, stopReason, reply) => {
    const { context, store, llmCalls } = makeContext({
      pluginConfig: { consolidation_enabled: true, min_notes_to_consolidate: 5, consolidation_cooldown_hours: 24 },
      initialState: { notes: [...sixNotes], lastModifiedMessageId: null },
      llmResponse: reply,
      llmStopReason: stopReason,
    })

    await notesPlugin.onPostActivation!(context, makeActivationResult([]))
    await notesPlugin.onPostActivation!(context, makeActivationResult([]))

    expect(llmCalls).toHaveLength(1)
    const state = store.get('channel') as { notes: unknown[]; lastConsolidationAttemptAt?: string; lastConsolidationAt?: string }
    expect(state.lastConsolidationAttemptAt).toBeDefined()
    expect(state.lastConsolidationAt).toBeUndefined()
    expect(state.notes).toHaveLength(6)
  })

  it('stamps no attempt when no cabinet qualifies', async () => {
    const { context, store, llmCalls } = makeContext({
      pluginConfig: { consolidation_enabled: true, min_notes_to_consolidate: 5 },
      initialState: { notes: sixNotes.slice(0, 3), lastModifiedMessageId: null },
      llmResponse: '[{"content":"merged","category":"tasks"}]',
    })

    await notesPlugin.onPostActivation!(context, makeActivationResult([]))

    expect(llmCalls).toHaveLength(0)
    expect((store.get('channel') as { lastConsolidationAttemptAt?: string }).lastConsolidationAttemptAt).toBeUndefined()
  })

  it('keeps originals when the LLM returns garbage', async () => {
    const { context, store } = makeContext({
      pluginConfig: { consolidation_enabled: true, min_notes_to_consolidate: 5 },
      initialState: { notes: [...sixNotes], lastModifiedMessageId: null },
      llmResponse: 'sorry, I cannot do that',
    })

    await notesPlugin.onPostActivation!(context, makeActivationResult([]))

    const state = store.get('channel') as { notes: unknown[]; preConsolidationBackup?: unknown }
    expect(state.notes).toHaveLength(6)
    expect(state.preConsolidationBackup).toBeUndefined()
  })

  it('skips cabinets below min_notes_to_consolidate', async () => {
    const { context, llmCalls } = makeContext({
      pluginConfig: { consolidation_enabled: true, min_notes_to_consolidate: 5 },
      initialState: { notes: sixNotes.slice(0, 3), lastModifiedMessageId: null },
      llmResponse: '[{"content":"merged","category":"tasks"}]',
    })

    await notesPlugin.onPostActivation!(context, makeActivationResult([]))
    expect(llmCalls).toHaveLength(0)
  })
})

describe('notes injection guard', () => {
  const oneNoteState = { notes: [makeNote('note_1', 'hello', 'general', 'msg-1')], lastModifiedMessageId: null }

  it('defers to compaction when the compaction plugin is active', async () => {
    const { context } = makeContext({
      pluginConfig: {},
      botConfig: { tool_plugins: ['notes', 'compaction'], plugin_config: { compaction: {} } },
      initialState: oneNoteState,
    })
    const injections = await notesPlugin.getContextInjections!(context)
    expect(injections).toHaveLength(0)
  })

  it('injects when compaction is not loaded', async () => {
    const { context } = makeContext({
      pluginConfig: {},
      botConfig: { tool_plugins: ['notes'] },
      initialState: oneNoteState,
    })
    const injections = await notesPlugin.getContextInjections!(context)
    expect(injections).toHaveLength(1)
    expect(injections[0]!.content).toContain('hello')
  })

  it('injects when explicitly enabled despite compaction being active', async () => {
    const { context } = makeContext({
      pluginConfig: { inject_into_context: true },
      botConfig: { tool_plugins: ['notes', 'compaction'], plugin_config: { compaction: {} } },
      initialState: oneNoteState,
    })
    const injections = await notesPlugin.getContextInjections!(context)
    expect(injections).toHaveLength(1)
  })
})
