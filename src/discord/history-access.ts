import {
  ChannelType,
  GuildMember,
  GuildTextBasedChannel,
  Message,
  PermissionFlagsBits
} from 'discord.js'

const READ = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]

export async function historyAuthor(
  message: Message,
  roles: string[]
): Promise<GuildMember | null> {
  if (!message.guild || message.author.bot || message.webhookId) return null
  try {
    const member = await message.guild.members.fetch({ user: message.author.id, force: true })
    const permissions = message.channel.isDMBased() ? null : message.channel.permissionsFor(member)
    if (!permissions?.has(READ)) return null
    return permissions.has(PermissionFlagsBits.ManageMessages) ||
      roles.some((id) => member.roles.cache.has(id))
      ? member
      : null
  } catch {
    return null
  }
}

/** Cross-channel imports must be readable by every member of the source guild. */
export function canImportHistory(
  member: GuildMember,
  source: GuildTextBasedChannel,
  destination: GuildTextBasedChannel
): boolean {
  if (source.guildId !== destination.guildId || member.guild.id !== source.guildId) return false
  if (!source.permissionsFor(member)?.has(READ)) return false
  if (source.id === destination.id) return true
  if (source.type === ChannelType.PrivateThread) return false
  const base = source.isThread() ? source.parent : source
  if (!base?.permissionsFor(source.guild.roles.everyone)?.has(READ)) return false
  // An everyone allow can still be overridden by member or role denies.
  return !base.permissionOverwrites.cache.some((overwrite) =>
    READ.some((bit) => overwrite.deny.has(bit))
  )
}
