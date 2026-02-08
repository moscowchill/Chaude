/**
 * Notes Plugin
 * 
 * Simple note-taking plugin that demonstrates:
 * - Channel-scoped persistent state
 * - Context injection with aging behavior
 * - Lifecycle hooks for updating injection depth
 */

import { ToolPlugin, PluginContext, PluginStateContext, ContextInjection, ActivationResult } from './types.js'
import { logger } from '../../utils/logger.js'

interface Note {
  id: string
  content: string
  category: string
  createdAt: string
  createdByMessageId: string
}

interface NotesState {
  notes: Note[]
  lastModifiedMessageId: string | null
  lastConsolidationAt?: string  // ISO date of last consolidation run
}

interface NotesConfig {
  inject_into_context?: boolean
  consolidation_enabled?: boolean
  consolidation_time?: string              // UTC hour (0-23) when consolidation may run, e.g. "4" or "04"
  consolidation_model?: string             // Model for consolidation (default: claude-opus-4-6)
  consolidation_cooldown_hours?: number    // Min hours between runs (default: 24)
  min_notes_to_consolidate?: number        // Min notes in a cabinet to trigger (default: 5)
}

const plugin: ToolPlugin = {
  name: 'notes',
  description: 'Simple note-taking plugin with context injection',
  
  tools: [
    {
      name: 'save_note',
      description: 'Save a note to a category cabinet. Notes are visible in the context and age toward a stable position.',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The note content to save',
          },
          category: {
            type: 'string',
            description: 'Category/cabinet to file this note under (e.g., "architecture", "decisions", "tasks", "releases"). Defaults to "general".',
          },
        },
        required: ['content'],
      },
      handler: async (input: { content: string }, context: PluginContext) => {
        // Note: For actual state management, this would use PluginStateContext
        // This handler just logs - real state updates happen in onToolExecution
        logger.debug({ 
          content: input.content.slice(0, 50),
          channelId: context.channelId 
        }, 'Note save requested')
        
        return `Note will be saved: "${input.content.slice(0, 50)}${input.content.length > 50 ? '...' : ''}"`
      },
    },
    {
      name: 'list_notes',
      description: 'List all saved notes grouped by category, optionally filtered to a specific category',
      inputSchema: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: 'Filter notes by category. Omit to list all notes grouped by category.',
          },
        },
      },
      handler: async (_input: unknown, context: PluginContext) => {
        logger.debug({ channelId: context.channelId }, 'Notes list requested')
        // Note: Handler can't access state directly, but we return a message
        // The actual notes are visible in context injection
        return 'Notes are displayed in context above. Use read_note with an ID to retrieve a specific note.'
      },
    },
    {
      name: 'read_note',
      description: 'Read a specific note by ID or search by title/content',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The note ID (e.g., note_abc123)',
          },
          search: {
            type: 'string',
            description: 'Search term to find notes by title or content',
          },
        },
      },
      handler: async (input: { id?: string; search?: string }, context: PluginContext) => {
        logger.debug({ 
          noteId: input.id,
          search: input.search,
          channelId: context.channelId 
        }, 'Note read requested')
        
        if (!input.id && !input.search) {
          return 'Please provide either an id or search term'
        }
        
        // Handler returns placeholder - actual retrieval happens in onToolExecution
        return input.id 
          ? `Looking up note: ${input.id}`
          : `Searching notes for: ${input.search}`
      },
    },
    {
      name: 'delete_note',
      description: 'Delete a note by ID',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The ID of the note to delete',
          },
        },
        required: ['id'],
      },
      handler: async (input: { id: string }, context: PluginContext) => {
        logger.debug({ 
          noteId: input.id,
          channelId: context.channelId 
        }, 'Note delete requested')
        
        return `Note ${input.id} will be deleted`
      },
    },
  ],
  
  /**
   * Get context injections - returns notes to be injected into context
   */
  getContextInjections: async (context: PluginStateContext): Promise<ContextInjection[]> => {
    // Check if injection is disabled via config (defaults to true)
    const config = context.pluginConfig as NotesConfig | undefined
    if (config?.inject_into_context === false) {
      return []
    }
    
    // Use configured scope (defaults to 'channel')
    const scope = context.configuredScope
    const state = await context.getState<NotesState>(scope)
    
    if (!state?.notes.length) {
      return []
    }
    
    // Group notes by category for display
    const categories = new Map<string, Note[]>()
    for (const note of state.notes) {
      const cat = note.category || 'general'
      if (!categories.has(cat)) categories.set(cat, [])
      categories.get(cat)!.push(note)
    }

    const sections: string[] = ['## Saved Notes', '']
    for (const [category, notes] of categories) {
      sections.push(`### ${category} (${notes.length})`)
      sections.push(...notes.map(note => `- [${note.id}] ${note.content}`))
      sections.push('')
    }
    sections.push('_Use save_note/delete_note to manage notes._')

    const notesContent = sections.join('\n')
    
    return [{
      id: 'notes-display',
      content: notesContent,
      targetDepth: 10,  // Settle near tool descriptions
      lastModifiedAt: state.lastModifiedMessageId,
      priority: 100,  // High priority - show before other injections
    }]
  },
  
  /**
   * Lifecycle hook - called after tool execution to update state
   */
  onToolExecution: async (
    toolName: string,
    input: unknown,
    _result: unknown,
    context: PluginStateContext
  ): Promise<void> => {
    const inputObj = input as Record<string, unknown>
    // Use configured scope (defaults to 'channel')
    const scope = context.configuredScope
    const state = await context.getState<NotesState>(scope) || {
      notes: [],
      lastModifiedMessageId: null,
    }
    
    if (toolName === 'save_note') {
      const rawCategory = (inputObj.category as string) || 'general'
      const category = rawCategory.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'general'

      const newNote: Note = {
        id: `note_${Date.now().toString(36)}`,
        content: inputObj.content as string,
        category,
        createdAt: new Date().toISOString(),
        createdByMessageId: context.currentMessageId,
      }

      state.notes.push(newNote)
      state.lastModifiedMessageId = context.currentMessageId

      await context.setState(scope, state)
      logger.info({
        noteId: newNote.id,
        category,
        channelId: context.channelId,
        scope
      }, 'Note saved')
    }
    
    if (toolName === 'delete_note') {
      const noteIndex = state.notes.findIndex(n => n.id === inputObj.id)
      if (noteIndex >= 0) {
        state.notes.splice(noteIndex, 1)
        state.lastModifiedMessageId = context.currentMessageId
        
        await context.setState(scope, state)
        logger.info({ 
          noteId: inputObj.id,
          channelId: context.channelId,
          scope 
        }, 'Note deleted')
      }
    }
  },
  
  /**
   * Post-process tool results to inject actual note content
   */
  postProcessResult: async (
    toolName: string,
    input: unknown,
    result: string,
    context: PluginStateContext
  ): Promise<string> => {
    const inputObj = input as Record<string, unknown>
    if (toolName === 'read_note') {
      const scope = context.configuredScope
      const state = await context.getState<NotesState>(scope)
      
      if (!state?.notes.length) {
        return 'No notes saved yet.'
      }
      
      if (inputObj.id) {
        const note = state.notes.find(n => n.id === inputObj.id)
        if (note) {
          return `**Note [${note.id}]** (created ${note.createdAt}):\n\n${note.content}`
        }
        return `Note not found: ${inputObj.id}`
      }

      if (inputObj.search) {
        const searchLower = (inputObj.search as string).toLowerCase()
        const matches = state.notes.filter(n =>
          n.content.toLowerCase().includes(searchLower)
        )

        if (matches.length === 0) {
          return `No notes found matching: "${inputObj.search}"`
        }

        if (matches.length === 1) {
          const note = matches[0]!
          return `**Note [${note.id}]** (created ${note.createdAt}):\n\n${note.content}`
        }

        return `Found ${matches.length} notes matching "${inputObj.search}":\n\n` +
          matches.map(n => `- [${n.id}] ${n.content.slice(0, 100)}${n.content.length > 100 ? '...' : ''}`).join('\n')
      }
      
      return result
    }
    
    if (toolName === 'list_notes') {
      const scope = context.configuredScope
      const state = await context.getState<NotesState>(scope)

      if (!state?.notes.length) {
        return 'No notes saved yet. Use save_note to create one.'
      }

      const filterCategory = inputObj.category
        ? (inputObj.category as string).toLowerCase().trim().replace(/\s+/g, '-')
        : null

      const grouped = new Map<string, Note[]>()
      for (const note of state.notes) {
        const cat = note.category || 'general'
        if (filterCategory && cat !== filterCategory) continue
        if (!grouped.has(cat)) grouped.set(cat, [])
        grouped.get(cat)!.push(note)
      }

      if (grouped.size === 0) {
        return filterCategory
          ? `No notes found in category "${filterCategory}".`
          : 'No notes saved yet.'
      }

      const sections: string[] = []
      for (const [category, notes] of grouped) {
        sections.push(`**${category}** (${notes.length} notes)`)
        for (const n of notes) {
          sections.push(`  - [${n.id}] ${n.content}`)
        }
        sections.push('')
      }

      return sections.join('\n')
    }
    
    return result
  },

  /**
   * Run note consolidation in background after activation.
   * Checks configured time window + cooldown, then uses a strong model
   * to deduplicate and merge notes within each cabinet.
   */
  onPostActivation: async (
    context: PluginStateContext,
    _result: ActivationResult
  ): Promise<void> => {
    const config = context.pluginConfig as NotesConfig | undefined
    if (!config?.consolidation_enabled) return
    if (!context.llmComplete) return

    // Check if current UTC hour matches configured consolidation time
    const targetHour = parseInt(config.consolidation_time || '4', 10)
    const currentHour = new Date().getUTCHours()
    if (currentHour !== targetHour) return

    const scope = context.configuredScope
    const state = await context.getState<NotesState>(scope)
    if (!state?.notes.length) return

    // Check cooldown
    const cooldownHours = config.consolidation_cooldown_hours ?? 24
    if (state.lastConsolidationAt) {
      const hoursSince = (Date.now() - new Date(state.lastConsolidationAt).getTime()) / (1000 * 60 * 60)
      if (hoursSince < cooldownHours) return
    }

    const minNotes = config.min_notes_to_consolidate ?? 5
    const model = config.consolidation_model || 'claude-opus-4-6'

    // Group notes by cabinet
    const cabinets = new Map<string, Note[]>()
    for (const note of state.notes) {
      const cat = note.category || 'general'
      if (!cabinets.has(cat)) cabinets.set(cat, [])
      cabinets.get(cat)!.push(note)
    }

    let totalRemoved = 0
    let totalCreated = 0
    const consolidatedCabinets: string[] = []

    for (const [category, notes] of cabinets) {
      if (notes.length < minNotes) continue

      const consolidated = await consolidateCabinet(context, category, notes, model)
      if (!consolidated) continue

      // Remove old notes for this cabinet, add consolidated ones
      state.notes = state.notes.filter(n => (n.category || 'general') !== category)
      state.notes.push(...consolidated)
      totalRemoved += notes.length
      totalCreated += consolidated.length
      consolidatedCabinets.push(`${category}: ${notes.length} → ${consolidated.length}`)
    }

    if (totalRemoved > 0) {
      state.lastConsolidationAt = new Date().toISOString()
      state.lastModifiedMessageId = context.currentMessageId
      await context.setState(scope, state)

      logger.info({
        channelId: context.channelId,
        removed: totalRemoved,
        created: totalCreated,
        cabinets: consolidatedCabinets,
      }, 'Notes consolidated')
    }
  },
}

/**
 * Consolidate a cabinet of notes using an LLM.
 * Identifies duplicates, merges overlapping notes, preserves all unique information.
 */
async function consolidateCabinet(
  context: PluginStateContext,
  category: string,
  notes: Note[],
  model: string
): Promise<Note[] | null> {
  if (!context.llmComplete) return null

  const notesText = notes
    .map((n, i) => `${i + 1}. [${n.id}] ${n.content}`)
    .join('\n')

  const prompt = `You are consolidating a cabinet of ${notes.length} notes in the "${category}" category. These notes were saved over time by a Discord bot and likely contain duplicates, overlapping information, and iterative updates where newer notes supersede older ones.

Current notes:
${notesText}

Your job:
1. Identify duplicate or heavily overlapping notes
2. Merge related notes into comprehensive single entries
3. Preserve ALL unique information — nothing should be lost
4. Ensure foundational context is explicit in each note (don't assume the reader knows background)
5. Remove pure duplicates entirely
6. Keep notes that are already unique and complete as-is
7. When notes represent iterative updates on the same topic, keep only the most complete/current version

Return a JSON array of consolidated notes. Each note object must have exactly two keys:
- "content": the full consolidated note text
- "category": "${category}"

Aim to significantly reduce the note count while preserving all unique information.

Respond with ONLY the JSON array, no other text.`

  try {
    const response = await context.llmComplete({
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = response.text.trim()
    const jsonStr = text.replace(/^```json?\s*|\s*```$/g, '').trim()
    const parsed = JSON.parse(jsonStr) as Array<{ content: string; category: string }>

    if (!Array.isArray(parsed) || parsed.length === 0) {
      logger.warn({ category }, 'Consolidation returned empty result — keeping originals')
      return null
    }

    // Sanity check: don't accept if it returned more notes than we started with
    if (parsed.length >= notes.length) {
      logger.debug({ category, before: notes.length, after: parsed.length }, 'Consolidation did not reduce notes — skipping')
      return null
    }

    const now = Date.now()
    return parsed.map((entry, i) => ({
      id: `note_${(now + i).toString(36)}`,
      content: entry.content,
      category: entry.category || category,
      createdAt: new Date().toISOString(),
      createdByMessageId: context.currentMessageId,
    }))
  } catch (error) {
    logger.error({ error, category, model }, 'Failed to consolidate cabinet')
    return null
  }
}

export default plugin

