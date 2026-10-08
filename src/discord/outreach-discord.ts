import {
  ChannelType,
  type Client,
  DiscordAPIError,
  GatewayIntentBits,
  type GuildMember,
  type NewsChannel,
  PermissionFlagsBits,
  type TextChannel,
} from 'discord.js'
import {
  DirectMessagesClosedError,
  normalizedName,
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
/** A full member list is fetched at most this often; discord.js keeps it cached between */
const MEMBER_LIST_TTL_MS = 10 * 60 * 1000

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
  const memberListAt = new Map<string, number>()
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
      // With the Server Members intent the whole list is available, display names included;
      // without it Discord only searches username and nickname prefixes
      if (client.options.intents.has(GatewayIntentBits.GuildMembers)) {
        if (Date.now() - (memberListAt.get(guildId) ?? 0) > MEMBER_LIST_TTL_MS) {
          await guild.members.fetch()
          memberListAt.set(guildId, Date.now())
        }
        return [...guild.members.cache.values()].map(toMember)
      }
      const members = await guild.members.fetch({ query, limit: 25 })
      return [...members.values()].map(toMember)
    },

    async channels(guildId, name) {
      const guild = await client.guilds.fetch(guildId)
      const me = await guild.members.fetchMe()
      const id = /^<#(\d{17,20})>$/.exec(name.trim())?.[1]
      const wanted = normalizedName(name)
      return [...(await guild.channels.fetch()).values()]
        .filter(
          (channel): channel is TextChannel | NewsChannel =>
            (channel?.type === ChannelType.GuildText ||
              channel?.type === ChannelType.GuildAnnouncement) &&
            (id ? channel.id === id : Boolean(wanted) && normalizedName(channel.name) === wanted) &&
            channel
              .permissionsFor(me)
              .has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])
        )
        .map((channel) => ({ id: channel.id, name: channel.name }))
    },

    async canSee(channelId, userId) {
      const channel = await client.channels.fetch(channelId)
      if (!channel || channel.isDMBased()) return false
      const member = await channel.guild.members.fetch(userId)
      return Boolean(channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel))
    },

    async sendToChannel(channelId, content, mentionUserId, nonce) {
      const channel = await client.channels.fetch(channelId)
      if (!channel?.isTextBased() || channel.isDMBased()) {
        throw new Error('Outreach can only post in a server text channel')
      }
      for (const [index, part] of splitMessage(content).entries()) {
        await channel.send({
          content: part,
          allowedMentions: { parse: [], users: [mentionUserId] },
          nonce: `${nonce}${index}`.slice(0, 25),
          enforceNonce: true,
        })
      }
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
            authorUsername: message.author.username,
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
