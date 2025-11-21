/**
 * HTTP API Server
 * Provides REST endpoints for accessing Discord conversation history
 */

import express, { Request, Response, NextFunction } from 'express'
import { DiscordConnector } from '../discord/connector.js'
import { logger } from '../utils/logger.js'

export interface ApiConfig {
  port: number
  bearerToken: string
}

export interface MessageExportRequest {
  last: string  // Discord message URL (required)
  first?: string  // Discord message URL to stop at (optional)
  recencyWindow?: {
    messages?: number
    characters?: number
  }
}

export interface MessageExportResponse {
  messages: Array<{
    id: string
    author: {
      id: string
      username: string
      displayName: string
      bot: boolean
      // Future: mappedParticipant?: string
    }
    content: string
    timestamp: string
    reactions: Array<{
      emoji: string
      count: number
    }>
    attachments: Array<{
      id: string
      url: string
      filename: string
      contentType?: string
      size: number
    }>
    referencedMessageId?: string
  }>
  metadata: {
    channelId: string
    guildId: string
    firstMessageId: string
    lastMessageId: string
    totalCount: number
    truncated: boolean
  }
}

export class ApiServer {
  private app = express()
  private server: any = null

  constructor(
    private config: ApiConfig,
    private connector: DiscordConnector
  ) {
    this.setupMiddleware()
    this.setupRoutes()
  }

  private setupMiddleware(): void {
    this.app.use(express.json())
    
    // Bearer token authentication
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      // Skip auth for health check
      if (req.path === '/health') {
        return next()
      }

      const authHeader = req.headers.authorization
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid authorization header' })
      }

      const token = authHeader.substring(7)
      if (token !== this.config.bearerToken) {
        return res.status(403).json({ error: 'Invalid bearer token' })
      }

      next()
    })
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() })
    })

    // Export messages endpoint
    this.app.post('/api/messages/export', async (req: Request, res: Response) => {
      try {
        const body = req.body as MessageExportRequest

        if (!body.last) {
          res.status(400).json({ error: 'Missing required parameter: last' })
          return
        }

        const result = await this.exportMessages(body)
        res.json(result)
      } catch (error: any) {
        logger.error({ error }, 'API error in /api/messages/export')
        res.status(500).json({ 
          error: 'Internal server error',
          message: error.message 
        })
      }
    })

    // Get user info
    this.app.get('/api/users/:userId', async (req: Request, res: Response) => {
      try {
        const userId = req.params.userId
        if (!userId) {
          res.status(400).json({ error: 'Missing userId parameter' })
          return
        }

        const guildId = req.query.guildId as string | undefined
        const userInfo = await this.getUserInfo(userId, guildId)
        res.json(userInfo)
      } catch (error: any) {
        logger.error({ error }, 'API error in /api/users/:userId')
        res.status(500).json({ 
          error: 'Internal server error',
          message: error.message 
        })
      }
    })

    // Get user avatar
    this.app.get('/api/users/:userId/avatar', async (req: Request, res: Response) => {
      try {
        const userId = req.params.userId
        if (!userId) {
          res.status(400).json({ error: 'Missing userId parameter' })
          return
        }

        const size = req.query.size ? parseInt(req.query.size as string) : 128
        const avatarUrl = await this.getUserAvatar(userId, size)
        
        if (!avatarUrl) {
          res.status(404).json({ error: 'Avatar not found' })
          return
        }

        res.json({ avatarUrl })
      } catch (error: any) {
        logger.error({ error }, 'API error in /api/users/:userId/avatar')
        res.status(500).json({ 
          error: 'Internal server error',
          message: error.message 
        })
      }
    })
  }

  private async exportMessages(request: MessageExportRequest): Promise<MessageExportResponse> {
    // Parse URLs to extract channel ID
    const channelId = this.extractChannelIdFromUrl(request.last)
    const guildId = this.extractGuildIdFromUrl(request.last)
    
    if (!channelId || !guildId) {
      throw new Error('Invalid Discord message URL format')
    }

    // Default recency window: 50 messages
    const recencyWindow = request.recencyWindow || { messages: 50 }
    
    // Calculate fetch depth (fetch a bit more for .history processing)
    const depth = Math.min((recencyWindow.messages || 50) + 100, 1000)

    // Use connector's fetchContext which handles .history commands automatically
    const context = await this.connector.fetchContext({
      channelId,
      depth,
    })

    let messages = context.messages

    // Apply recency window
    const beforeTruncate = messages.length
    messages = this.applyRecencyWindow(messages, recencyWindow)
    if (beforeTruncate > messages.length) {
      logger.debug({ beforeTruncate, afterTruncate: messages.length }, 'Applied recency window')
    }

    // Transform to export format (from DiscordMessage to API format)
    const exportedMessages = messages.map((msg: any) => ({
      id: msg.id,
      author: {
        id: msg.author.id,
        username: msg.author.username,
        displayName: msg.author.displayName,
        bot: msg.author.bot,
        // Future: mappedParticipant will go here
      },
      content: msg.content,
      timestamp: msg.timestamp.toISOString(),
      reactions: msg.reactions || [],
      attachments: msg.attachments.map((att: any) => ({
        id: att.id,
        url: att.url,
        filename: att.filename,
        contentType: att.contentType,
        size: att.size,
      })),
      referencedMessageId: msg.referencedMessage,
    }))

    const wasExplicitlyTruncated = !!(request.recencyWindow 
      && context.messages.length > messages.length)

    return {
      messages: exportedMessages,
      metadata: {
        channelId,
        guildId,
        firstMessageId: messages[0]?.id || '',
        lastMessageId: messages[messages.length - 1]?.id || '',
        totalCount: messages.length,
        truncated: wasExplicitlyTruncated,
      },
    }
  }

  private async getUserInfo(userId: string, guildId?: string): Promise<any> {
    const client = (this.connector as any).client
    
    // Fetch user from Discord
    const user = await client.users.fetch(userId)
    if (!user) {
      throw new Error('User not found')
    }

    // Get guild-specific info if guildId provided
    let displayName = user.username
    let roles: string[] = []
    
    if (guildId) {
      try {
        const guild = await client.guilds.fetch(guildId)
        const member = await guild.members.fetch(userId)
        displayName = member.displayName || user.username
        roles = member.roles.cache.map((r: any) => r.name).filter((n: string) => n !== '@everyone')
      } catch (error) {
        logger.warn({ error, userId, guildId }, 'Failed to fetch guild member info')
      }
    }

    return {
      id: user.id,
      username: user.username,
      displayName,
      discriminator: user.discriminator,
      bot: user.bot,
      avatarUrl: user.displayAvatarURL({ size: 128 }),
      roles: guildId ? roles : undefined,
    }
  }

  private async getUserAvatar(userId: string, size: number = 128): Promise<string | null> {
    const client = (this.connector as any).client
    
    try {
      const user = await client.users.fetch(userId)
      if (!user) return null

      return user.displayAvatarURL({ size, extension: 'png' })
    } catch (error) {
      logger.warn({ error, userId }, 'Failed to fetch user avatar')
      return null
    }
  }

  private applyRecencyWindow(messages: any[], window: { messages?: number, characters?: number }): any[] {
    let result = messages

    // Apply message limit
    if (window.messages && messages.length > window.messages) {
      result = messages.slice(-window.messages)
    }

    // Apply character limit
    if (window.characters) {
      const kept: any[] = []
      let charCount = 0

      // Work backwards from most recent
      for (let i = result.length - 1; i >= 0; i--) {
        const msg = result[i] as any
        if (!msg) continue
        
        const msgLength = (msg.content || '').length
        
        if (charCount + msgLength > window.characters && kept.length > 0) {
          break
        }
        
        kept.unshift(msg)
        charCount += msgLength
      }
      
      result = kept
    }

    return result
  }

  private extractChannelIdFromUrl(url: string): string | null {
    const match = url.match(/\/channels\/\d+\/(\d+)\/\d+/)
    return match ? match[1]! : null
  }

  private extractGuildIdFromUrl(url: string): string | null {
    const match = url.match(/\/channels\/(\d+)\/\d+\/\d+/)
    return match ? match[1]! : null
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.config.port, () => {
        logger.info({ port: this.config.port }, 'API server started')
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          logger.info('API server stopped')
          resolve()
        })
      })
    }
  }
}

