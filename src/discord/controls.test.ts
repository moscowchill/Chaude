import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PermissionFlagsBits, PermissionsBitField, type Client } from 'discord.js'
import { installControls } from './controls.js'

const manager = { getChannelState: vi.fn(), setChannelState: vi.fn() }
vi.mock('../tools/plugins/state.js', () => ({
  PluginStateManager: class {
    getChannelState = manager.getChannelState
    setChannelState = manager.setChannelState
  }
}))
beforeEach(() => vi.clearAllMocks())
const guildId = '11111111111111111'

async function setup(command: string, canManage = false) {
  let handler!: (interaction: unknown) => Promise<void>
  const create = vi.fn().mockResolvedValue(undefined)
  const client = {
    application: { commands: { create } },
    on: (_name: string, fn: typeof handler) => {
      handler = fn
    }
  } as unknown as Client
  await installControls(client, {
    guildIds: [guildId],
    cacheDir: '/synthetic-cache',
    getModel: () => 'test-model'
  })
  const interaction = {
    isChatInputCommand: () => true,
    commandName: command,
    guildId,
    channelId: '22222222222222222',
    guild: { members: { fetch: vi.fn().mockResolvedValue({ id: 'user' }) } },
    user: { id: 'user' },
    channel: {
      isDMBased: () => false,
      permissionsFor: () =>
        new PermissionsBitField([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
          ...(canManage ? [PermissionFlagsBits.ManageMessages] : [])
        ])
    },
    options: { getString: () => 'note_123', getInteger: () => 1 },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined)
  }
  return { create, interaction, handler }
}

describe('Discord memory controls', () => {
  it('upserts only the four owned command names', async () => {
    const { create } = await setup('memory')
    expect(create.mock.calls.map((call) => call[0].name)).toEqual([
      'status',
      'knowledge',
      'memory',
      'forget'
    ])
    expect(create.mock.calls.every((call) => call[1] === guildId)).toBe(true)
  })
  it('rejects an unauthorized forget at runtime before reading state', async () => {
    const { handler, interaction } = await setup('forget')
    await handler(interaction)
    expect(manager.getChannelState).not.toHaveBeenCalled()
    expect(manager.setChannelState).not.toHaveBeenCalled()
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Manage Messages') })
    )
  })
  it('removes only the requested channel note and clears the consolidation restore copy', async () => {
    const { handler, interaction } = await setup('forget', true)
    manager.getChannelState.mockResolvedValue({
      state: {
        notes: [{ id: 'note_123' }, { id: 'keep' }],
        preConsolidationBackup: { notes: [{ id: 'old' }] }
      }
    })
    await handler(interaction)
    expect(manager.getChannelState).toHaveBeenCalledWith(interaction.channelId)
    expect(manager.setChannelState).toHaveBeenCalledWith(
      interaction.channelId,
      expect.objectContaining({ notes: [{ id: 'keep' }], preConsolidationBackup: { notes: [] } })
    )
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ allowedMentions: { parse: [] } })
    )
  })
  it('ignores interactions from unconfigured guilds', async () => {
    const { handler, interaction } = await setup('memory')
    await handler({ ...interaction, guildId: 'other' })
    expect(interaction.deferReply).not.toHaveBeenCalled()
    expect(manager.getChannelState).not.toHaveBeenCalled()
  })
})
