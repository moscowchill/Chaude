import {
  ChannelType,
  type Client,
  DiscordAPIError,
  type GuildMember,
  type NewsChannel,
  PermissionFlagsBits,
  type TextChannel,
} from 'discord.js'
import {
  DirectMessagesClosedError,
  type OutreachChannelMessage,
  type OutreachDiscord,
  type OutreachMember,
} from './outreach.js'

/** Discord API error codes */
const UNKNOWN_MEMBER = 10007
const UNKNOWN_USER = 10013
const CANNOT_MESSAGE_USER = 50007
/** Public channels read per scan, most recently active first */
const MAX_CHANNELS = 15
const MESSAGE_LIMIT = 1900

const toMember = (member: GuildMember): OutreachMember => ({
  id: member.id,
  name: member.displayName,
  username: member.user.username,
  isBot: member.user.bot,
})

const isApiError = (error: unknown, ...codes: number[]) =>
  error instanceof DiscordAPIError && codes.includes(Number(error.code))

function newestFirst(a: string | null, b: string | null): number {
  const left = BigInt(a ?? 0)
  const right = BigInt(b ?? 0)
  return left === right ? 0 : left < right ? 1 : -1
}

/** Splits at line breaks where possible, so each part fits one Discord message */
export function splitMessage(content: string, limit = MESSAGE_LIMIT): string[] {
  const parts: string[] = []
  let rest = content
  while (rest.length > limit) {
    const cut = rest.lastIndexOf('\n', limit)
    const at = cut > limit / 2 ? cut : limit
    parts.push(rest.slice(0, at))
    rest = rest.slice(at).replace(/^\n/, '')
  }
  if (rest) parts.push(rest)
  return parts
}

export function createOutreachDiscord(client: Client): OutreachDiscord {
  return {
    async guildName(guildId) {
      return (await client.guilds.fetch(guildId)).name
    },

    async member(guildId, userId) {
      const guild = await client.guilds.fetch(guildId)
      try {
        return toMember(await guild.members.fetch(userId))
      } catch (error) {
        if (isApiError(error, UNKNOWN_MEMBER, UNKNOWN_USER)) return undefined
        throw error
      }
    },

    async findMembers(guildId, query) {
      const guild = await client.guilds.fetch(guildId)
      const members = await guild.members.fetch({ query, limit: 10 })
      return [...members.values()].map(toMember)
    },

    async message(channelId, messageId) {
      const channel = await client.channels.fetch(channelId)
      if (!channel?.isTextBased() || channel.isDMBased()) return undefined
      const message = await channel.messages.fetch(messageId)
      // A reply to someone's message counts as naming them
      const users = [...message.mentions.users.values()]
      const replied = message.mentions.repliedUser
      if (replied && !users.some((user) => user.id === replied.id)) users.push(replied)
      const self = client.user?.id
      return {
        authorId: message.author.id,
        content: message.content,
        addressesBot: self !== undefined && (message.mentions.users.has(self) || replied?.id === self),
        mentions: users.map((user) => ({
          id: user.id,
          name: message.mentions.members?.get(user.id)?.displayName ?? user.globalName ?? user.username,
          username: user.username,
          isBot: user.bot,
        })),
      }
    },

    async publicMessages(guildId) {
      const guild = await client.guilds.fetch(guildId)
      const me = await guild.members.fetchMe()
      const everyone = guild.roles.everyone
      // Only channels everyone can read: what a member said there is already public
      const channels = [...(await guild.channels.fetch()).values()]
        .filter(
          (channel): channel is TextChannel | NewsChannel =>
            (channel?.type === ChannelType.GuildText ||
              channel?.type === ChannelType.GuildAnnouncement) &&
            channel.permissionsFor(everyone).has(PermissionFlagsBits.ViewChannel) &&
            channel
              .permissionsFor(me)
              .has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])
        )
        .sort((a, b) => newestFirst(a.lastMessageId, b.lastMessageId))
        .slice(0, MAX_CHANNELS)
      const messages: OutreachChannelMessage[] = []
      for (const channel of channels) {
        const batch = await channel.messages.fetch({ limit: 100 })
        for (const message of batch.values()) {
          if (message.system || message.webhookId) continue
          messages.push({
            authorId: message.author.id,
            authorName:
              message.member?.displayName ?? message.author.globalName ?? message.author.username,
            isBot: message.author.bot,
            channelName: channel.name,
            content: message.content,
            createdAt: message.createdTimestamp,
          })
        }
      }
      return messages
    },

    async sendDirect(userId, content, nonce) {
      try {
        const channel = await (await client.users.fetch(userId)).createDM()
        for (const [index, part] of splitMessage(content).entries()) {
          // One attempt with a nonce: Discord drops a duplicate if a send is retried
          await channel.send({
            content: part,
            allowedMentions: { parse: [] },
            nonce: `${nonce}${index}`.slice(0, 25),
            enforceNonce: true,
          })
        }
      } catch (error) {
        if (isApiError(error, CANNOT_MESSAGE_USER)) throw new DirectMessagesClosedError()
        throw error
      }
    },

    async react(channelId, messageId, emoji) {
      const channel = await client.channels.fetch(channelId)
      if (!channel?.isDMBased()) return
      await (await channel.messages.fetch(messageId)).react(emoji)
    },
  }
}
