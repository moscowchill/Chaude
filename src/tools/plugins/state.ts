/**
 * Plugin State Manager
 * 
 * Handles persistent state for plugins with different scopes:
 * - global: Instant, unrewindable state
 * - channel: Inherits through .history jumps and threads
 * - epic: Event-sourced state that forks with threads and rolls back on message deletion
 */

import { promises as fs } from 'fs'
import path from 'path'
import { logger } from '../../utils/logger.js'

export type StateScope = 'global' | 'channel' | 'epic' | 'off'

export interface StateEvent {
  messageId: string
  timestamp: string
  delta: any  // The state change
}

export interface ChannelStateMetadata {
  lastModifiedMessageId: string | null
  parentChannelId?: string  // For threads
  historyOriginChannelId?: string  // For .history jumps
}

export class PluginStateManager {
  private cacheDir: string
  private pluginId: string
  
  // In-memory cache for performance
  private globalCache: any = null
  private channelCache = new Map<string, any>()
  private epicEventsCache = new Map<string, StateEvent[]>()
  
  constructor(cacheDir: string, pluginId: string) {
    this.cacheDir = cacheDir
    this.pluginId = pluginId
  }
  
  // ================== Global State ==================
  
  private get globalPath(): string {
    return path.join(this.cacheDir, 'plugins', this.pluginId, 'global.json')
  }
  
  async getGlobalState<T>(): Promise<T | null> {
    if (this.globalCache !== null) {
      return this.globalCache as T
    }
    
    try {
      const data = await fs.readFile(this.globalPath, 'utf-8')
      this.globalCache = JSON.parse(data)
      return this.globalCache as T
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return null
      }
      logger.error({ err, pluginId: this.pluginId }, 'Failed to read global state')
      throw err
    }
  }
  
  async setGlobalState<T>(state: T): Promise<void> {
    await fs.mkdir(path.dirname(this.globalPath), { recursive: true })
    await fs.writeFile(this.globalPath, JSON.stringify(state, null, 2))
    this.globalCache = state
    logger.debug({ pluginId: this.pluginId }, 'Saved global state')
  }
  
  // ================== Channel State ==================
  
  private channelPath(channelId: string): string {
    return path.join(this.cacheDir, 'plugins', this.pluginId, 'channel', `${channelId}.json`)
  }
  
  /**
   * Get channel state, optionally inheriting from parent/history origin
   */
  async getChannelState<T>(
    channelId: string,
    inheritFrom?: { parentChannelId?: string; historyOriginChannelId?: string }
  ): Promise<{ state: T | null; metadata: ChannelStateMetadata }> {
    // Check cache first
    if (this.channelCache.has(channelId)) {
      return this.channelCache.get(channelId)
    }
    
    try {
      const data = await fs.readFile(this.channelPath(channelId), 'utf-8')
      const parsed = JSON.parse(data)
      const result = {
        state: parsed.state as T,
        metadata: parsed.metadata as ChannelStateMetadata,
      }
      this.channelCache.set(channelId, result)
      return result
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        // No state for this channel - try inheriting
        if (inheritFrom?.historyOriginChannelId) {
          // .history jump - inherit from origin
          const origin = await this.getChannelState<T>(inheritFrom.historyOriginChannelId)
          if (origin.state) {
            logger.debug({ 
              pluginId: this.pluginId, 
              channelId, 
              origin: inheritFrom.historyOriginChannelId 
            }, 'Inheriting channel state from .history origin')
            return {
              state: origin.state,
              metadata: {
                ...origin.metadata,
                historyOriginChannelId: inheritFrom.historyOriginChannelId,
              },
            }
          }
        }
        
        if (inheritFrom?.parentChannelId) {
          // Thread - inherit from parent at thread creation point
          const parent = await this.getChannelState<T>(inheritFrom.parentChannelId)
          if (parent.state) {
            logger.debug({ 
              pluginId: this.pluginId, 
              channelId, 
              parent: inheritFrom.parentChannelId 
            }, 'Inheriting channel state from parent channel')
            return {
              state: parent.state,
              metadata: {
                ...parent.metadata,
                parentChannelId: inheritFrom.parentChannelId,
              },
            }
          }
        }
        
        return { state: null, metadata: { lastModifiedMessageId: null } }
      }
      logger.error({ err, pluginId: this.pluginId, channelId }, 'Failed to read channel state')
      throw err
    }
  }
  
  async setChannelState<T>(
    channelId: string,
    state: T,
    messageId?: string
  ): Promise<void> {
    const existing = await this.getChannelState<T>(channelId)
    const metadata: ChannelStateMetadata = {
      ...existing.metadata,
      lastModifiedMessageId: messageId || existing.metadata.lastModifiedMessageId,
    }
    
    const data = { state, metadata }
    await fs.mkdir(path.dirname(this.channelPath(channelId)), { recursive: true })
    await fs.writeFile(this.channelPath(channelId), JSON.stringify(data, null, 2))
    this.channelCache.set(channelId, data)
    
    logger.debug({ 
      pluginId: this.pluginId, 
      channelId, 
      messageId 
    }, 'Saved channel state')
  }
  
  // ================== Epic State (Event-Sourced) ==================
  
  private epicEventsPath(channelId: string): string {
    return path.join(this.cacheDir, 'plugins', this.pluginId, 'epic', `${channelId}.json`)
  }
  
  /**
   * Get all events for a channel
   */
  private async getEpicEvents(channelId: string): Promise<StateEvent[]> {
    if (this.epicEventsCache.has(channelId)) {
      return this.epicEventsCache.get(channelId)!
    }
    
    try {
      const data = await fs.readFile(this.epicEventsPath(channelId), 'utf-8')
      const events = JSON.parse(data) as StateEvent[]
      this.epicEventsCache.set(channelId, events)
      return events
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return []
      }
      throw err
    }
  }
  
  private async saveEpicEvents(channelId: string, events: StateEvent[]): Promise<void> {
    await fs.mkdir(path.dirname(this.epicEventsPath(channelId)), { recursive: true })
    await fs.writeFile(this.epicEventsPath(channelId), JSON.stringify(events, null, 2))
    this.epicEventsCache.set(channelId, events)
  }
  
  /**
   * Record a state change tied to a message ID
   */
  async recordEpicEvent(channelId: string, messageId: string, delta: any): Promise<void> {
    const events = await this.getEpicEvents(channelId)
    
    // Remove any existing event for this message (update case)
    const filtered = events.filter(e => e.messageId !== messageId)
    
    filtered.push({
      messageId,
      timestamp: new Date().toISOString(),
      delta,
    })
    
    // Sort by messageId (Discord snowflake IDs are chronologically ordered)
    filtered.sort((a, b) => a.messageId.localeCompare(b.messageId))
    
    await this.saveEpicEvents(channelId, filtered)
    logger.debug({ pluginId: this.pluginId, channelId, messageId }, 'Recorded epic event')
  }
  
  /**
   * Reconstruct state by replaying events up to a given message ID
   * 
   * @param channelId Channel to get state for
   * @param upToMessageId Only replay events up to this message (inclusive)
   * @param messageIds Optional set of valid message IDs - events for deleted messages are skipped
   * @param reducer Function to apply each delta to build state
   */
  async getEpicState<T>(
    channelId: string,
    upToMessageId: string | null,
    messageIds: Set<string> | null,
    reducer: (state: T | null, delta: any) => T
  ): Promise<T | null> {
    const events = await this.getEpicEvents(channelId)
    
    let state: T | null = null
    
    for (const event of events) {
      // Stop if past the target message
      if (upToMessageId && event.messageId.localeCompare(upToMessageId) > 0) {
        break
      }
      
      // Skip events for deleted messages (rollback behavior)
      if (messageIds && !messageIds.has(event.messageId)) {
        logger.debug({ 
          pluginId: this.pluginId, 
          messageId: event.messageId 
        }, 'Skipping epic event for deleted message')
        continue
      }
      
      state = reducer(state, event.delta)
    }
    
    return state
  }
  
  /**
   * Fork epic state for a thread
   * Copies all events up to the thread creation message
   */
  async forkEpicState(
    parentChannelId: string,
    threadId: string,
    threadCreationMessageId: string
  ): Promise<void> {
    const parentEvents = await this.getEpicEvents(parentChannelId)
    
    // Copy events up to (and including) the thread creation message
    const forkedEvents = parentEvents.filter(
      e => e.messageId.localeCompare(threadCreationMessageId) <= 0
    )
    
    if (forkedEvents.length > 0) {
      await this.saveEpicEvents(threadId, forkedEvents)
      logger.debug({ 
        pluginId: this.pluginId, 
        parentChannelId, 
        threadId, 
        eventCount: forkedEvents.length 
      }, 'Forked epic state for thread')
    }
  }
  
  // ================== Utilities ==================
  
  /**
   * Clear all cached data (useful for testing or memory management)
   */
  clearCache(): void {
    this.globalCache = null
    this.channelCache.clear()
    this.epicEventsCache.clear()
  }
}


