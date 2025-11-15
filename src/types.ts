/**
 * Core types for Chapter3 Discord bot framework
 * 
 * This file defines the normalized multi-participant API that serves as the
 * interface between Context Builder and LLM Middleware.
 */

// ============================================================================
// Normalized Multi-Participant Format
// ============================================================================

/**
 * Complete request to LLM Middleware
 * Uses participant-based format (not role-based)
 */
export interface LLMRequest {
  messages: ParticipantMessage[]
  systemPrompt?: string
  config: ModelConfig
  tools?: ToolDefinition[]
  stopSequences?: string[]
}

/**
 * Result of context building, including metadata
 */
export interface ContextBuildResult {
  request: LLMRequest
  didRoll: boolean
  cacheMarker: string | null
}

/**
 * Message from a single participant (human or bot)
 * Core abstraction - no artificial "user" vs "assistant" roles
 */
export interface ParticipantMessage {
  participant: string  // "Alice", "Bob", "Claude", etc.
  content: ContentBlock[]
  timestamp?: Date
  messageId?: string  // Discord message ID (for cache markers)
  cacheControl?: CacheControl
}

/**
 * Content blocks - supports text, images, and tool use
 */
export type ContentBlock = 
  | TextContent
  | ImageContent
  | ToolUseContent
  | ToolResultContent

export interface TextContent {
  type: 'text'
  text: string
}

export interface ImageContent {
  type: 'image'
  source: {
    type: 'base64' | 'url'
    data: string  // base64 data or URL
    media_type: string  // 'image/jpeg', 'image/png', etc. (snake_case for Anthropic API)
  }
}

export interface ToolUseContent {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, any>
}

export interface ToolResultContent {
  type: 'tool_result'
  toolUseId: string
  content: string | ContentBlock[]
  isError?: boolean
}

export interface CacheControl {
  type: 'ephemeral'
}

// ============================================================================
// LLM Response Format
// ============================================================================

/**
 * Response from LLM Middleware
 */
export interface LLMCompletion {
  content: ContentBlock[]  // May contain text and tool_use blocks
  stopReason: StopReason
  usage: UsageInfo
  model: string
  raw?: any  // Optional: raw provider response for debugging
}

export type StopReason = 
  | 'end_turn'      // Natural completion
  | 'max_tokens'    // Hit token limit
  | 'stop_sequence' // Hit stop sequence
  | 'tool_use'      // Stopped for tool use

export interface UsageInfo {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Model configuration (subset of BotConfig)
 */
export interface ModelConfig {
  model: string
  temperature: number
  maxTokens: number
  topP: number
  mode: 'prefill' | 'chat'
  botInnerName: string  // For building stop sequences
}

/**
 * Complete bot configuration
 */
export interface BotConfig {
  // Identity
  name: string
  innerName: string
  
  // Model config
  mode: 'prefill' | 'chat'
  continuationModel: string
  temperature: number
  maxTokens: number
  topP: number
  
  // Context config
  recencyWindowMessages?: number  // Max number of messages
  recencyWindowCharacters?: number  // Max number of characters
  hardMaxCharacters?: number  // Hard maximum - never exceeded (prevents API errors)
  rollingThreshold: number  // Messages before truncation
  recentParticipantCount: number  // Number of recent participants for stop sequences
  authorizedRoles: string[]  // Roles authorized to use .history commands
  
  // Image config
  includeImages: boolean
  maxImages: number
  
  // Tool config
  toolsEnabled: boolean
  toolOutputVisible: boolean
  maxToolDepth: number
  mcpServers?: MCPServerConfig[]
  
  // Stop sequences
  stopSequences: string[]
  
  // Retries
  llmRetries: number
  discordBackoffMax: number
  
  // Misc
  systemPrompt?: string
  replyOnRandom: number
  replyOnName: boolean
  maxQueuedReplies: number
}

/**
 * Vendor configuration for LLM providers
 */
export interface VendorConfig {
  config: Record<string, string>
  provides: string[]  // Model name patterns (regex)
}

// ============================================================================
// Tool System
// ============================================================================

export interface MCPServerConfig {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: JSONSchema
  serverName?: string  // Which MCP server provides this tool
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, any>
  messageId: string  // For pruning old calls
  timestamp: Date
  originalCompletionText: string  // The bot's original text including XML tool call
}

export interface ToolCallWithResult {
  call: ToolCall
  result: ToolResult
}

export interface ToolResult {
  callId: string
  output: any
  error?: string
  timestamp: Date
}

/**
 * JSON Schema type (simplified)
 */
export interface JSONSchema {
  type: string
  properties?: Record<string, JSONSchema>
  items?: JSONSchema
  required?: string[]
  description?: string
  enum?: any[]
  [key: string]: any
}

// ============================================================================
// Discord Domain
// ============================================================================

/**
 * Discord message (raw from Discord API)
 */
export interface DiscordMessage {
  id: string
  channelId: string
  guildId: string
  author: {
    id: string
    username: string
    displayName: string
    bot: boolean
  }
  content: string
  timestamp: Date
  attachments: DiscordAttachment[]
  mentions: string[]  // User IDs
  referencedMessage?: string  // Reply to message ID
}

export interface DiscordAttachment {
  id: string
  url: string
  filename: string
  contentType?: string
  size: number
  width?: number
  height?: number
}

/**
 * Context fetched from Discord
 */
export interface DiscordContext {
  messages: DiscordMessage[]
  pinnedConfigs: string[]  // Raw YAML strings from pinned messages
  images: CachedImage[]
  guildId: string
}

export interface CachedImage {
  url: string
  data: Buffer
  mediaType: string
  hash: string
}

// ============================================================================
// Events
// ============================================================================

export interface Event {
  type: EventType
  channelId: string
  guildId: string
  data: any
  timestamp: Date
}

export type EventType = 
  | 'message' 
  | 'reaction' 
  | 'edit' 
  | 'delete' 
  | 'self_activation'  // Bot activates itself (e.g., timer)
  | 'timer' 
  | 'internal'

// ============================================================================
// Channel State
// ============================================================================

/**
 * Per-channel state managed by ChannelStateManager
 */
export interface ChannelState {
  toolCache: ToolCall[]
  lastCacheMarker: string | null  // Message ID
  messagesSinceRoll: number
}

// ============================================================================
// Error Types
// ============================================================================

export class Chapter3Error extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: any
  ) {
    super(message)
    this.name = 'Chapter3Error'
  }
}

export class ConfigError extends Chapter3Error {
  constructor(message: string, details?: any) {
    super(message, 'CONFIG_ERROR', details)
    this.name = 'ConfigError'
  }
}

export class DiscordError extends Chapter3Error {
  constructor(message: string, details?: any) {
    super(message, 'DISCORD_ERROR', details)
    this.name = 'DiscordError'
  }
}

export class LLMError extends Chapter3Error {
  constructor(message: string, details?: any) {
    super(message, 'LLM_ERROR', details)
    this.name = 'LLMError'
  }
}

export class ToolError extends Chapter3Error {
  constructor(message: string, details?: any) {
    super(message, 'TOOL_ERROR', details)
    this.name = 'ToolError'
  }
}

