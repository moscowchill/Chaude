/**
 * Context Builder
 * Transforms Discord messages to normalized participant-based format
 */

import {
  LLMRequest,
  ContextBuildResult,
  ParticipantMessage,
  ContentBlock,
  DiscordMessage,
  DiscordContext,
  CachedImage,
  ToolCall,
  BotConfig,
  ModelConfig,
} from '../types.js'
import { logger } from '../utils/logger.js'
import { 
  ContextBuildInfo, 
  ContextMessageInfo,
  MessageTransformation,
  getCurrentTrace,
} from '../trace/index.js'
import {
  estimateMessageTokens,
  estimateSystemTokens,
  extractTextContent,
} from '../trace/tokens.js'

export interface BuildContextParams {
  discordContext: DiscordContext
  toolCacheWithResults: Array<{call: ToolCall, result: any}>
  lastCacheMarker: string | null
  messagesSinceRoll: number
  config: BotConfig
}

export interface ContextBuildResultWithTrace extends ContextBuildResult {
  /** Trace info for debugging (only populated if tracing is active) */
  traceInfo?: ContextBuildInfo
}

export class ContextBuilder {
  /**
   * Build LLM request from Discord context
   */
  buildContext(params: BuildContextParams): ContextBuildResultWithTrace {
    const { discordContext, toolCacheWithResults, lastCacheMarker, messagesSinceRoll, config } = params
    const originalMessageCount = discordContext.messages.length

    let messages = discordContext.messages

    // Track which messages were merged (for tracing)
    const mergedMessageIds = new Set<string>()
    
    // 1. Merge consecutive bot messages
    const beforeMerge = messages.length
    messages = this.mergeConsecutiveBotMessages(messages, config.innerName)
    if (messages.length < beforeMerge) {
      // Some messages were merged - track them
      const afterIds = new Set(messages.map(m => m.id))
      discordContext.messages.forEach(m => {
        if (!afterIds.has(m.id)) mergedMessageIds.add(m.id)
      })
    }

    // 2. Filter dot messages
    const beforeFilter = messages.length
    messages = this.filterDotMessages(messages)
    const filteredCount = beforeFilter - messages.length

    // 3. Convert to participant messages (limits applied later on final context)
    const participantMessages = this.formatMessages(messages, discordContext.images, config)

    // 5. Interleave historical tool use from cache (limited to last 5 calls with results)
    // Tools are inserted chronologically where they occurred, not at the end
    const toolMessagesByTrigger = this.formatToolUseWithResults(toolCacheWithResults, config.innerName)
    
    // Create a map of triggering message ID -> tool messages
    const toolsByMessageId = new Map<string, ParticipantMessage[]>()
    for (let i = 0; i < toolMessagesByTrigger.length; i += 2) {
      const toolCall = toolMessagesByTrigger[i]
      const toolResult = toolMessagesByTrigger[i + 1]
      if (toolCall && toolResult) {
        const messageId = toolCall.messageId || ''
        if (!toolsByMessageId.has(messageId)) {
          toolsByMessageId.set(messageId, [])
        }
        toolsByMessageId.get(messageId)!.push(toolCall, toolResult)
      }
    }
    
    // Interleave tools with messages based on messageId
    const interleavedMessages: ParticipantMessage[] = []
    for (const msg of participantMessages) {
      interleavedMessages.push(msg)
      // Add any tools triggered by this message
      if (msg.messageId && toolsByMessageId.has(msg.messageId)) {
        interleavedMessages.push(...toolsByMessageId.get(msg.messageId)!)
      }
    }
    
    logger.debug({ 
      discordMessages: messages.length,
      toolCallsWithResults: toolCacheWithResults.length,
      toolMessages: toolMessagesByTrigger.length,
      interleavedTotal: interleavedMessages.length 
    }, 'Context assembly complete with interleaved tools')
    
    // Replace participantMessages with interleaved version
    participantMessages.length = 0
    participantMessages.push(...interleavedMessages)

    // 5. Apply limits on final assembled context (after images & tools added)
    const { messages: finalMessages, didTruncate, messagesRemoved } = this.applyLimits(
      participantMessages, 
      messagesSinceRoll,
      config
    )
    participantMessages.length = 0
    participantMessages.push(...finalMessages)

    // 6. Determine cache marker
    const cacheMarker = this.determineCacheMarker(messages, lastCacheMarker, didTruncate)

    // Apply cache marker to appropriate message
    if (cacheMarker) {
      const msgWithMarker = participantMessages.find((m) => m.messageId === cacheMarker)
      if (msgWithMarker) {
        msgWithMarker.cacheControl = { type: 'ephemeral' }
      }
    }

    // 7. Add empty message for bot to complete
    participantMessages.push({
      participant: config.innerName,
      content: [{ type: 'text', text: '' }],
    })

    // 8. Build stop sequences (from recent participants only)
    const stop_sequences = this.buildStopSequences(participantMessages, config)

    logger.debug({ stop_sequences, participantCount: participantMessages.length }, 'Built stop sequences')

    const request: LLMRequest = {
      messages: participantMessages,
      system_prompt: config.system_prompt,
      config: this.extractModelConfig(config),
      tools: config.tools_enabled ? undefined : undefined,  // Tools added by Agent Loop
      stop_sequences,
    }

    // Build trace info if tracing is active
    const traceInfo = this.buildTraceInfo(
      participantMessages,
      discordContext,
      toolCacheWithResults,
      config,
      {
        originalMessageCount,
        filteredCount,
        mergedMessageIds,
        didTruncate,
        messagesRolledOff: messagesRemoved || 0,
        cacheMarker,
        lastCacheMarker,
        stopSequences: stop_sequences,
      }
    )
    
    // Record to active trace if available
    if (traceInfo) {
      getCurrentTrace()?.recordContextBuild(traceInfo)
    }

    return {
      request,
      didRoll: didTruncate,
      cacheMarker,
      traceInfo,
    }
  }
  
  /**
   * Build trace info for debugging
   */
  private buildTraceInfo(
    finalMessages: ParticipantMessage[],
    _discordContext: DiscordContext,
    toolCacheWithResults: Array<{call: ToolCall, result: any}>,
    config: BotConfig,
    metadata: {
      originalMessageCount: number
      filteredCount: number
      mergedMessageIds: Set<string>
      didTruncate: boolean
      messagesRolledOff: number
      cacheMarker: string | null
      lastCacheMarker: string | null
      stopSequences: string[]
    }
  ): ContextBuildInfo | undefined {
    // Build message info for each message in final context
    const messageInfos: ContextMessageInfo[] = []
    const triggeringMessageId = finalMessages.length > 1 
      ? finalMessages[finalMessages.length - 2]?.messageId  // Last message before empty completion
      : undefined
    
    // Count images
    let totalImages = 0
    const imageDetails: ContextBuildInfo['imageDetails'] = []
    
    for (let i = 0; i < finalMessages.length; i++) {
      const msg = finalMessages[i]!
      if (!msg.content.length) continue  // Skip empty completion message
      
      const transformations: MessageTransformation[] = []
      
      // Check for merged messages
      if (msg.messageId && metadata.mergedMessageIds.has(msg.messageId)) {
        transformations.push('merged_consecutive')
      }
      
      // Check for images
      let imageCount = 0
      for (const block of msg.content) {
        if (block.type === 'image') {
          imageCount++
          totalImages++
          // Add image detail
          imageDetails.push({
            discordMessageId: msg.messageId || '',
            url: 'embedded',  // Base64 embedded
            tokenEstimate: 1000,  // Rough estimate
          })
        }
      }
      if (imageCount > 0) {
        transformations.push('image_extracted')
      }
      
      // Check for cache control
      const hasCacheControl = !!msg.cacheControl
      
      const textContent = extractTextContent(msg)
      
      messageInfos.push({
        position: i,
        discordMessageId: msg.messageId || null,
        participant: msg.participant,
        contentPreview: textContent.slice(0, 150) + (textContent.length > 150 ? '...' : ''),
        contentLength: textContent.length,
        tokenEstimate: estimateMessageTokens(msg),
        transformations,
        isTrigger: msg.messageId === triggeringMessageId,
        hasImages: imageCount > 0,
        imageCount,
        hasCacheControl,
        discordTimestamp: msg.timestamp,
      })
    }
    
    // Calculate token estimates
    const systemTokens = estimateSystemTokens(config.system_prompt)
    let messageTokens = 0
    let imageTokens = 0
    let toolTokens = 0
    
    for (const msg of finalMessages) {
      const msgTokens = estimateMessageTokens(msg)
      
      // Categorize by participant
      if (msg.participant.startsWith('System<[')) {
        toolTokens += msgTokens
      } else {
        // Check for images
        for (const block of msg.content) {
          if (block.type === 'image') {
            imageTokens += 1000
          }
        }
        messageTokens += msgTokens - (msg.content.filter(b => b.type === 'image').length * 1000)
      }
    }
    
    // Build tool cache details
    const toolCacheDetails: ContextBuildInfo['toolCacheDetails'] = toolCacheWithResults.map(t => ({
      toolName: t.call.name,
      triggeringMessageId: t.call.messageId,
      tokenEstimate: estimateMessageTokens({
        participant: 'System',
        content: [{ type: 'text', text: JSON.stringify(t.result) }],
      }),
    }))
    
    return {
      messagesConsidered: metadata.originalMessageCount,
      messagesIncluded: finalMessages.length - 1,  // Exclude empty completion message
      messages: messageInfos,
      imagesIncluded: totalImages,
      imageDetails,
      toolCacheEntries: toolCacheWithResults.length,
      toolCacheDetails,
      didTruncate: metadata.didTruncate,
      truncateReason: metadata.didTruncate 
        ? (metadata.messagesRolledOff > 0 ? 'rolling_threshold' : 'character_limit')
        : undefined,
      messagesRolledOff: metadata.messagesRolledOff,
      cacheMarker: metadata.cacheMarker || undefined,
      previousCacheMarker: metadata.lastCacheMarker || undefined,
      stopSequences: metadata.stopSequences,
      tokenEstimates: {
        system: systemTokens,
        messages: messageTokens,
        images: imageTokens,
        tools: toolTokens,
        total: systemTokens + messageTokens + imageTokens + toolTokens,
      },
      configSnapshot: {
        recencyWindow: config.recency_window_messages || 0,
        rollingThreshold: config.rolling_threshold,
        maxImages: config.max_images || 0,
        mode: config.mode,
      },
    }
  }

  private mergeConsecutiveBotMessages(
    messages: DiscordMessage[],
    botName: string
  ): DiscordMessage[] {
    const merged: DiscordMessage[] = []

    for (const msg of messages) {
      const isBotMessage = msg.author.displayName === botName
      const lastMsg = merged[merged.length - 1]
      
      // Don't merge messages starting with "." (tool outputs, preambles)
      // These need to stay separate so they can be filtered later
      const isDotMessage = msg.content.trim().startsWith('.')
      const lastIsDotMessage = lastMsg?.content.trim().startsWith('.')

      if (
        isBotMessage &&
        lastMsg &&
        lastMsg.author.displayName === botName &&
        !isDotMessage &&
        !lastIsDotMessage
      ) {
        // Merge with previous message (space separator)
        lastMsg.content = `${lastMsg.content} ${msg.content}`
        // Keep attachments
        lastMsg.attachments.push(...msg.attachments)
      } else {
        merged.push({ ...msg })
      }
    }

    return merged
  }

  private filterDotMessages(messages: DiscordMessage[]): DiscordMessage[] {
    return messages.filter((msg) => {
      // Filter messages starting with period
      if (msg.content.trim().startsWith('.')) {
        return false
      }
      // Filter messages with dotted_face emoji (🙃)
      if (msg.content.includes('🙃')) {
        return false
      }
      return true
    })
  }


  /**
   * Apply limits on assembled context (after images and tools added)
   * This is the ONLY place limits are enforced - accounts for total payload size
   */
  private applyLimits(
    messages: ParticipantMessage[],
    messagesSinceRoll: number,
    config: BotConfig
  ): { messages: ParticipantMessage[], didTruncate: boolean, messagesRemoved?: number } {
    const shouldRoll = messagesSinceRoll >= config.rolling_threshold
    
    // Calculate total size of FINAL context (text + images + tool results)
    let totalChars = 0
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          totalChars += (block as any).text.length
        } else if (block.type === 'image') {
          // Base64 data counts toward payload size
          const imageBlock = block as any
          if (imageBlock.source?.data) {
            totalChars += imageBlock.source.data.length
          }
        } else if (block.type === 'tool_result') {
          const toolBlock = block as any
          const content = typeof toolBlock.content === 'string' 
            ? toolBlock.content 
            : JSON.stringify(toolBlock.content)
          totalChars += content.length
        }
      }
    }
    
    const hardMaxCharacters = config.hard_max_characters || 500000
    const normalLimit = config.recency_window_characters || 100000  // Default normal limit
    
    // ALWAYS enforce hard maximum (even when not rolling)
    // When exceeded, truncate to NORMAL limit (not hard max) to reset cache properly
    if (totalChars > hardMaxCharacters) {
      logger.warn({
        totalChars,
        hardMax: hardMaxCharacters,
        normalLimit,
        messageCount: messages.length
      }, 'HARD LIMIT EXCEEDED - Truncating to normal limit and forcing roll')
      
      const result = this.truncateToLimit(messages, normalLimit, true)
      return { ...result, messagesRemoved: messages.length - result.messages.length }
    }
    
    // If not rolling yet, allow normal limits to be exceeded (for cache efficiency)
    if (!shouldRoll) {
      logger.debug({
        messagesSinceRoll,
        threshold: config.rolling_threshold,
        messageCount: messages.length,
        totalChars,
        totalMB: (totalChars / 1024 / 1024).toFixed(2)
      }, 'Not rolling yet - keeping all messages for cache')
      return { messages, didTruncate: false, messagesRemoved: 0 }
    }
    
    // Time to roll - check normal limits
    const messageLimit = config.recency_window_messages || Infinity
    
    // Apply character limit
    if (totalChars > normalLimit) {
      logger.info({
        totalChars,
        limit: normalLimit,
        messageCount: messages.length
      }, 'Rolling: Character limit exceeded, truncating final context')
      const result = this.truncateToLimit(messages, normalLimit, true)
      return { ...result, messagesRemoved: messages.length - result.messages.length }
    }
    
    // Apply message count limit
    if (messages.length > messageLimit) {
      logger.info({
        messageCount: messages.length,
        limit: messageLimit,
        keptChars: totalChars
      }, 'Rolling: Message count limit exceeded, truncating')
      const removed = messages.length - messageLimit
      return { 
        messages: messages.slice(messages.length - messageLimit), 
        didTruncate: true,
        messagesRemoved: removed,
      }
    }
    
    return { messages, didTruncate: false, messagesRemoved: 0 }
  }
  
  /**
   * Helper to truncate messages to character limit (works on ParticipantMessage[])
   */
  private truncateToLimit(
    messages: ParticipantMessage[], 
    charLimit: number,
    isHardLimit: boolean
  ): { messages: ParticipantMessage[], didTruncate: boolean } {
    let keptChars = 0
    let cutoffIndex = messages.length
    
    // Count from end backwards
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!
      let msgSize = 0
      
      for (const block of msg.content) {
        if (block.type === 'text') {
          msgSize += (block as any).text.length
        } else if (block.type === 'image') {
          const imageBlock = block as any
          if (imageBlock.source?.data) {
            msgSize += imageBlock.source.data.length
          }
        } else if (block.type === 'tool_result') {
          const toolBlock = block as any
          const content = typeof toolBlock.content === 'string' 
            ? toolBlock.content 
            : JSON.stringify(toolBlock.content)
          msgSize += content.length
        }
      }
      
      if (keptChars + msgSize > charLimit) {
        cutoffIndex = i + 1
        break
      }
      
      keptChars += msgSize
    }
    
    const truncated = messages.slice(cutoffIndex)
    
    if (cutoffIndex > 0) {
      logger.warn({
        removed: cutoffIndex,
        kept: truncated.length,
        keptChars,
        limitType: isHardLimit ? 'HARD' : 'normal',
        charLimit
      }, `Truncated final context to ${isHardLimit ? 'HARD' : 'normal'} limit`)
    }
    
    return { messages: truncated, didTruncate: cutoffIndex > 0 }
  }

  private determineCacheMarker(
    messages: DiscordMessage[],
    lastMarker: string | null,
    didRoll: boolean
  ): string | null {
    if (messages.length === 0) {
      return null
    }

    // If we didn't roll, keep the same marker if it's still in the message list
    if (!didRoll && lastMarker) {
      const markerStillExists = messages.some((m) => m.id === lastMarker)
      if (markerStillExists) {
        return lastMarker
      }
    }

    // If we rolled or marker is invalid, place new marker
    // Place marker 5 messages from the end, or at the oldest message
    const offset = 5
    const index = Math.max(0, messages.length - offset)
    return messages[index]!.id
  }

  private formatMessages(
    messages: DiscordMessage[],
    images: CachedImage[],
    config: BotConfig
  ): ParticipantMessage[] {
    const participantMessages: ParticipantMessage[] = []

    // Create image lookup
    const imageMap = new Map(images.map((img) => [img.url, img]))
    
    // Track image count and total base64 payload size to stay under API limits
    // Anthropic has ~10MB total request limit, we want to keep images under 3-4MB
    let imageCount = 0
    let totalBase64Size = 0
    const max_images = config.max_images || 5
    const maxTotalBase64Bytes = 3 * 1024 * 1024  // 3 MB total base64 data for images
    
    logger.debug({
      messageCount: messages.length,
      cachedImages: images.length,
      imageUrls: images.map(i => i.url),
      include_images: config.include_images,
      max_images,
      maxTotalImageMB: maxTotalBase64Bytes / 1024 / 1024
    }, 'Starting formatMessages with images')

    for (const msg of messages) {
      const content: ContentBlock[] = []

      // Add text content
      if (msg.content.trim()) {
        content.push({
          type: 'text',
          text: msg.content,
        })
      }

      // Add image content (if enabled and within limits)
      if (config.include_images && msg.attachments.length > 0 && imageCount < max_images) {
        logger.debug({ messageId: msg.id, attachments: msg.attachments.length }, 'Processing attachments for message')
        
        for (const attachment of msg.attachments) {
          if (imageCount >= max_images) {
            logger.debug({ max_images, currentCount: imageCount }, 'Reached max_images count limit, skipping remaining images')
            break
          }
          
          if (attachment.contentType?.startsWith('image/')) {
            const cached = imageMap.get(attachment.url)
            
            if (cached) {
              const base64Data = cached.data.toString('base64')
              const base64Size = base64Data.length
              
              // Check if adding this image would exceed total size limit
              if (totalBase64Size + base64Size > maxTotalBase64Bytes) {
                logger.warn({ 
                  currentTotalMB: (totalBase64Size / 1024 / 1024).toFixed(2),
                  imageSizeMB: (base64Size / 1024 / 1024).toFixed(2),
                  maxTotalMB: (maxTotalBase64Bytes / 1024 / 1024).toFixed(1),
                  imageCount,
                  url: attachment.url
                }, 'Skipping image - would exceed total size limit')
                break  // Stop adding more images
              }
              
              logger.debug({ 
                url: attachment.url, 
                imageSizeMB: (base64Size / 1024 / 1024).toFixed(2),
                currentImageCount: imageCount,
                currentTotalMB: (totalBase64Size / 1024 / 1024).toFixed(2)
              }, 'Adding image to content')
              
              content.push({
                type: 'image',
                source: {
                  type: 'base64',
                  data: base64Data,
                  media_type: cached.mediaType,  // Anthropic API uses snake_case
                },
              })
              imageCount++
              totalBase64Size += base64Size
              
              logger.debug({ 
                messageId: msg.id, 
                imageCount, 
                max_images,
                totalImageMB: (totalBase64Size / 1024 / 1024).toFixed(2)
              }, 'Added image to content')
            }
          }
        }
      }

      participantMessages.push({
        participant: msg.author.displayName,
        content,
        timestamp: msg.timestamp,
        messageId: msg.id,
      })
    }

    // Limit images if needed
    if (config.include_images && config.max_images > 0) {
      this.limitImages(participantMessages, config.max_images)
    }

    return participantMessages
  }

  private limitImages(messages: ParticipantMessage[], max_images: number): void {
    // Count and collect image positions
    let imageCount = 0
    const imagePositions: Array<{ msgIndex: number; contentIndex: number }> = []

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!
      for (let j = 0; j < msg.content.length; j++) {
        if (msg.content[j]!.type === 'image') {
          imageCount++
          imagePositions.push({ msgIndex: i, contentIndex: j })
        }
      }
    }

    // Remove oldest images if over limit
    if (imageCount > max_images) {
      const toRemove = imageCount - max_images

      for (let i = 0; i < toRemove; i++) {
        const pos = imagePositions[i]!
        messages[pos.msgIndex]!.content.splice(pos.contentIndex, 1)
      }
    }
  }

  private formatToolUseWithResults(
    toolCacheWithResults: Array<{call: ToolCall, result: any}>, 
    botName: string
  ): ParticipantMessage[] {
    const messages: ParticipantMessage[] = []

    for (const entry of toolCacheWithResults) {
      // Bot's message with original completion text (includes XML tool call)
      messages.push({
        participant: botName,
        content: [
          {
            type: 'text',
            text: entry.call.originalCompletionText,
          },
        ],
        timestamp: entry.call.timestamp,
        messageId: entry.call.messageId,
      })

      // Tool result message from SYSTEM (not bot)
      const resultText = typeof entry.result === 'string' ? entry.result : JSON.stringify(entry.result)
      messages.push({
        participant: `System<[${entry.call.name}]`,
        content: [
          {
            type: 'text',
            text: resultText,
          },
        ],
        timestamp: entry.call.timestamp,
        messageId: entry.call.messageId,
      })
    }

    return messages
  }

  /**
   * Format tool results as participant messages (for tool loop)
   * Tool results are attributed to System, not the bot
   */
  formatToolResults(
    toolCalls: Array<{ call: ToolCall; result: any }>
  ): ParticipantMessage[] {
    const messages: ParticipantMessage[] = []

    for (const { call, result } of toolCalls) {
      // Tool result message from System
      const resultText = typeof result === 'string' ? result : JSON.stringify(result)
      messages.push({
        participant: `System<[${call.name}]`,
        content: [
          {
            type: 'text',
            text: resultText,
          },
        ],
        timestamp: new Date(),
      })
    }

    return messages
  }

  private buildStopSequences(
    participantMessages: ParticipantMessage[],
    config: BotConfig
  ): string[] {
    const sequences: string[] = []

    // Get recent N unique participants (from most recent messages)
    const recentParticipants: string[] = []
    const seen = new Set<string>()

    // Iterate backwards to get most recent participants
    for (let i = participantMessages.length - 1; i >= 0 && recentParticipants.length < config.recent_participant_count; i--) {
      const participant = participantMessages[i]?.participant
      if (participant && !seen.has(participant)) {
        seen.add(participant)
        recentParticipants.push(participant)
      }
    }

    // Add participant names with colon
    for (const participant of recentParticipants) {
      sequences.push(`${participant}:`)
    }

    // Add system message prefixes (bot should never generate these)
    sequences.push('System<[', 'System>[')

    // Add configured stop sequences
    sequences.push(...config.stop_sequences)

    return sequences
  }

  private extractModelConfig(config: BotConfig): ModelConfig {
    return {
      model: config.continuation_model,
      temperature: config.temperature,
      max_tokens: config.max_tokens,
      top_p: config.top_p,
      mode: config.mode,
      prefill_thinking: config.prefill_thinking,
      botInnerName: config.innerName,
    }
  }
}

