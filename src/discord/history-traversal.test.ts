import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Collection, PermissionsBitField, PermissionFlagsBits as P } from 'discord.js'
import { DiscordConnector } from './connector.js'
import { EventQueue } from '../agent/event-queue.js'

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
let connector: DiscordConnector
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'history-traversal-'))
  connector = new DiscordConnector(new EventQueue(), {
    token: 'synthetic',
    cacheDir: dir,
    maxBackoffMs: 10
  })
})
afterEach(async () => {
  await connector.close()
  await rm(dir, { recursive: true, force: true })
})

describe('history traversal disclosure regression', () => {
  it.each([false, true])(
    'does not fetch private message bodies for a history author (manager=%s)',
    async (manager) => {
      const guild = {
        id: '11111111111111111',
        roles: { everyone: { id: 'everyone' } },
        members: { fetch: vi.fn() }
      }
      const member = { guild, roles: { cache: new Collection() } }
      guild.members.fetch.mockResolvedValue(member)
      const read = [P.ViewChannel, P.ReadMessageHistory, ...(manager ? [P.ManageMessages] : [])]
      const target = {
        id: '22222222222222222',
        guildId: guild.id,
        guild,
        name: 'synthetic-private',
        isTextBased: () => true,
        isThread: () => false,
        permissionsFor: (who: unknown) =>
          new PermissionsBitField(who === guild.roles.everyone ? [] : read),
        permissionOverwrites: { cache: new Collection() },
        messages: { fetch: vi.fn().mockRejectedValue(new Error('Private body must never be read')) }
      }
      const channel = {
        id: '33333333333333333',
        guildId: guild.id,
        guild,
        name: 'synthetic-public',
        isDMBased: () => false,
        isThread: () => false,
        permissionsFor: () => new PermissionsBitField(read),
        permissionOverwrites: { cache: new Collection() },
        messages: { fetch: vi.fn() }
      }
      const command = {
        id: '44444444444444444',
        guild,
        channel,
        author: { id: '55555555555555555', bot: false },
        content: `.history\n---\nlast: https://discord.com/channels/${guild.id}/${target.id}/66666666666666666`
      }
      channel.messages.fetch.mockImplementation(async (options: { before?: string }) =>
        options.before ? new Collection() : new Collection([[command.id, command]])
      )
      const internals = connector as unknown as {
        client: { channels: { fetch: ReturnType<typeof vi.fn> } }
        fetchMessagesRecursive: (
          channel: unknown,
          start: undefined,
          end: undefined,
          depth: number,
          roles: string[]
        ) => Promise<unknown[]>
      }
      internals.client.channels.fetch = vi.fn().mockResolvedValue(target)
      expect(await internals.fetchMessagesRecursive(channel, undefined, undefined, 10, [])).toEqual(
        []
      )
      expect(target.messages.fetch).not.toHaveBeenCalled()
      expect(internals.client.channels.fetch).toHaveBeenCalledTimes(manager ? 1 : 0)
    }
  )
})
