import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logger } from '../utils/logger.js'

const DEFAULT_MESSAGE = "Welcome, {user}! Glad you're here. What brings you to the server?"
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const SNOWFLAKE = /^\d{17,20}$/

export interface WelcomeConfig {
  guildId: string
  channelId: string
  message: string
  statePath: string
}

export interface WelcomeMember {
  guildId: string
  userId: string
  isBot: boolean
  pending: boolean
  joinedTimestamp: number | null
}

export interface WelcomeMessage {
  guildId: string
  channelId: string
  userId: string
  content: string
  nonce: string
}

/** Environment settings keep welcome routing under the server owner's control. */
export function loadWelcomeConfig(
  env: NodeJS.ProcessEnv,
  cachePath: string
): WelcomeConfig | undefined {
  const guildId = env.WELCOME_GUILD_ID?.trim()
  const channelId = env.WELCOME_CHANNEL_ID?.trim()
  if (!guildId && !channelId) return undefined
  if (!guildId || !channelId || !SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(channelId)) {
    throw new Error('WELCOME_GUILD_ID and WELCOME_CHANNEL_ID must both be Discord IDs')
  }
  const message = env.WELCOME_MESSAGE?.trim() || DEFAULT_MESSAGE
  const rendered = message.replaceAll('{user}', `<@${'1'.repeat(20)}>`)
  if (rendered.length > 1800) throw new Error('WELCOME_MESSAGE exceeds 1800 characters')
  return { guildId, channelId, message, statePath: join(cachePath, 'member-welcomes.json') }
}

/** One welcome per join, persisted across restarts and serialized across events. */
export class WelcomeService {
  private welcomed: Record<string, number> = {}
  private queue: Promise<void> = Promise.resolve()
  private stateAvailable = true

  constructor(
    private config: WelcomeConfig,
    private send: (message: WelcomeMessage) => Promise<void>
  ) {
    try {
      if (!existsSync(config.statePath)) return
      const stored: unknown = JSON.parse(readFileSync(config.statePath, 'utf8'))
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
        throw new Error('Invalid member welcome state')
      }
      for (const [userId, timestamp] of Object.entries(stored)) {
        if (
          !SNOWFLAKE.test(userId) ||
          typeof timestamp !== 'number' ||
          !Number.isFinite(timestamp)
        ) {
          throw new Error('Invalid member welcome record')
        }
        this.welcomed[userId] = timestamp
      }
    } catch (error) {
      this.stateAvailable = false
      logger.error({ err: error }, 'Member welcomes paused: saved state could not be read')
    }
  }

  welcome(member: WelcomeMember): Promise<void> {
    const task = this.queue.then(() => this.welcomeOnce(member))
    this.queue = task.catch((error: unknown) => {
      logger.error(
        { err: error, guildId: member.guildId, userId: member.userId },
        'Member welcome failed'
      )
    })
    return this.queue
  }

  private async welcomeOnce(member: WelcomeMember): Promise<void> {
    const joinedAt = member.joinedTimestamp
    if (
      !this.stateAvailable ||
      member.guildId !== this.config.guildId ||
      member.isBot ||
      member.pending
    )
      return
    if (!SNOWFLAKE.test(member.userId) || joinedAt === null || !Number.isFinite(joinedAt)) return
    // Old gateway replays should not greet long-standing members.
    if (joinedAt < Date.now() - RETENTION_MS) return
    if ((this.welcomed[member.userId] ?? 0) >= joinedAt) return

    const nonce = createHash('sha256')
      .update(`${member.guildId}:${member.userId}:${joinedAt}`)
      .digest('hex')
      .slice(0, 24)
    await this.send({
      guildId: member.guildId,
      channelId: this.config.channelId,
      userId: member.userId,
      content: this.config.message.replaceAll('{user}', `<@${member.userId}>`),
      nonce
    })

    this.welcomed[member.userId] = joinedAt
    const cutoff = Date.now() - RETENTION_MS
    for (const [userId, timestamp] of Object.entries(this.welcomed)) {
      if (timestamp < cutoff) delete this.welcomed[userId]
    }
    mkdirSync(dirname(this.config.statePath), { recursive: true })
    const temporary = `${this.config.statePath}.tmp`
    writeFileSync(temporary, JSON.stringify(this.welcomed), { mode: 0o600 })
    renameSync(temporary, this.config.statePath)
    logger.info(
      { guildId: member.guildId, channelId: this.config.channelId, userId: member.userId },
      'Welcomed new member'
    )
  }
}
