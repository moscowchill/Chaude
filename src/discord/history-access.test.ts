import { describe, expect, it, vi } from 'vitest'
import {
  ChannelType,
  Collection,
  PermissionsBitField,
  PermissionFlagsBits as P,
  type GuildMember,
  type Message,
  type TextChannel
} from 'discord.js'
import { canImportHistory, historyAuthor } from './history-access.js'

const READ = [P.ViewChannel, P.ReadMessageHistory]
function fixture(
  options: {
    manager?: boolean
    roles?: string[]
    public?: boolean
    deny?: bigint
    guildId?: string
  } = {}
) {
  const guild = {
    id: options.guildId || 'guild',
    roles: { everyone: { id: 'everyone' } },
    members: { fetch: vi.fn() }
  }
  const member = {
    id: 'user',
    guild,
    roles: { cache: new Collection((options.roles || []).map((id) => [id, { id }])) }
  } as unknown as GuildMember
  guild.members.fetch.mockResolvedValue(member)
  const channel = {
    id: 'source',
    guildId: guild.id,
    guild,
    type: ChannelType.GuildText,
    isThread: () => false,
    isDMBased: () => false,
    permissionsFor: (who: unknown) =>
      new PermissionsBitField(
        who === guild.roles.everyone
          ? options.public === false
            ? []
            : READ
          : [...READ, ...(options.manager ? [P.ManageMessages] : [])]
      ),
    permissionOverwrites: {
      cache: new Collection(
        options.deny ? [['restricted', { deny: new PermissionsBitField(options.deny) }]] : []
      )
    }
  } as unknown as TextChannel
  const message = {
    guild,
    channel,
    author: { id: 'user', bot: false },
    webhookId: null
  } as unknown as Message
  return { guild, member, channel, message }
}

describe('history authorization', () => {
  it('requires management permission or an explicit role ID even for a clear', async () => {
    expect(await historyAuthor(fixture().message, [])).toBeNull()
    const manager = fixture({ manager: true })
    expect(await historyAuthor(manager.message, [])).toBe(manager.member)
    expect(manager.guild.members.fetch).toHaveBeenCalledWith({ user: 'user', force: true })
    const allowed = fixture({ roles: ['role-id'] })
    expect(await historyAuthor(allowed.message, ['role-id'])).toBe(allowed.member)
    expect(await historyAuthor(allowed.message, ['Role Name'])).toBeNull()
  })
  it('rejects bot/webhook controls and membership lookup failures', async () => {
    const f = fixture({ manager: true })
    expect(await historyAuthor({ ...f.message, webhookId: 'hook' } as Message, [])).toBeNull()
    expect(
      await historyAuthor({ ...f.message, author: { id: 'user', bot: true } } as Message, [])
    ).toBeNull()
    f.guild.members.fetch.mockRejectedValue(new Error('gone'))
    expect(await historyAuthor(f.message, [])).toBeNull()
  })
  it('allows same-channel history and public cross-channel history', () => {
    const f = fixture({ manager: true })
    expect(canImportHistory(f.member, f.channel, f.channel)).toBe(true)
    expect(
      canImportHistory(f.member, f.channel, { ...f.channel, id: 'destination' } as TextChannel)
    ).toBe(true)
  })
  it('blocks private history disclosure even by a manager who can see the source', () => {
    const f = fixture({ manager: true, public: false })
    expect(
      canImportHistory(f.member, f.channel, { ...f.channel, id: 'destination' } as TextChannel)
    ).toBe(false)
    expect(canImportHistory(f.member, f.channel, f.channel)).toBe(true)
  })
  it.each([P.ViewChannel, P.ReadMessageHistory])('honors role/member denies (%s)', (deny) => {
    const f = fixture({ deny })
    expect(
      canImportHistory(f.member, f.channel, { ...f.channel, id: 'destination' } as TextChannel)
    ).toBe(false)
  })
  it('blocks private threads, other guilds, and sources inaccessible to the author', () => {
    const f = fixture()
    const dest = { ...f.channel, id: 'destination' } as TextChannel
    expect(
      canImportHistory(
        f.member,
        { ...f.channel, type: ChannelType.PrivateThread } as TextChannel,
        dest
      )
    ).toBe(false)
    expect(
      canImportHistory(f.member, f.channel, { ...dest, guildId: 'other' } as TextChannel)
    ).toBe(false)
    expect(
      canImportHistory(
        f.member,
        { ...f.channel, permissionsFor: () => new PermissionsBitField() } as TextChannel,
        dest
      )
    ).toBe(false)
  })
})
