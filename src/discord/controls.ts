import {
  ApplicationCommandOptionType,
  type ApplicationCommandDataResolvable,
  Client,
  MessageFlags,
  PermissionFlagsBits
} from 'discord.js'
import type { KnowledgeBase } from '../knowledge/base.js'
import type { DailyBudget } from '../llm/budget.js'
import { PluginStateManager } from '../tools/plugins/state.js'
import { memoryQueue } from '../utils/atomic-state.js'
import { logger } from '../utils/logger.js'

interface Note {
  id: string
  content: string
  createdAt: string
  createdByMessageId: string
  sourceUrls?: string[]
}
interface Notes {
  notes: Note[]
  preConsolidationBackup?: { notes: Note[] }
  [key: string]: unknown
}
export interface ControlsOptions {
  guildIds: string[]
  cacheDir: string
  knowledge?: KnowledgeBase
  budget?: DailyBudget
  getModel: (guildId: string) => string
  getLastFailure?: () => { at: string; status?: number } | undefined
}

export async function installControls(client: Client, options: ControlsOptions): Promise<void> {
  if (!client.application) throw new Error('Discord application is unavailable')
  for (const guildId of options.guildIds) {
    if (!/^\d{17,20}$/.test(guildId)) throw new Error('Invalid control guild ID')
    // Upsert only our names, preserving unrelated application commands.
    for (const command of [
      { name: 'status', description: 'Show model, daily budget and knowledge coverage' },
      {
        name: 'knowledge',
        description: 'Read the curated community guide and its sources',
        options: [
          {
            name: 'topic',
            description: 'Topic name or search words',
            type: ApplicationCommandOptionType.String,
            maxLength: 100
          }
        ]
      },
      {
        name: 'memory',
        description: 'Inspect conversation notes saved in this channel',
        options: [
          {
            name: 'id',
            description: 'Read a specific note ID',
            type: ApplicationCommandOptionType.String,
            maxLength: 100
          },
          {
            name: 'page',
            description: 'Page number',
            type: ApplicationCommandOptionType.Integer,
            minValue: 1,
            maxValue: 1000
          }
        ]
      },
      {
        name: 'forget',
        description: 'Remove a saved conversation note from this channel',
        defaultMemberPermissions: PermissionFlagsBits.ManageMessages,
        options: [
          {
            name: 'id',
            description: 'Exact note ID from /memory',
            type: ApplicationCommandOptionType.String,
            required: true,
            maxLength: 100
          }
        ]
      }
    ] satisfies ApplicationCommandDataResolvable[])
      await client.application.commands.create(command, guildId)
  }

  client.on('interactionCreate', async (interaction) => {
    if (
      !interaction.isChatInputCommand() ||
      !['status', 'knowledge', 'memory', 'forget'].includes(interaction.commandName)
    )
      return
    if (!interaction.guildId || !options.guildIds.includes(interaction.guildId)) return
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral })
      const respond = (content: string) =>
        interaction.editReply({ content: content.slice(0, 1950), allowedMentions: { parse: [] } })
      const channel = interaction.channel
      if (!interaction.guild || !channel || channel.isDMBased()) {
        await respond('Use this command in a server channel.')
        return
      }
      const member = await interaction.guild.members.fetch({
        user: interaction.user.id,
        force: true
      })
      const permissions = channel.permissionsFor(member)
      if (
        !permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])
      ) {
        await respond('You need access to this channel and its message history.')
        return
      }
      if (interaction.commandName === 'status') {
        const budget = await options.budget?.status()
        const failure = options.getLastFailure?.()
        await respond(
          [
            `Default model: ${options.getModel(interaction.guildId)}`,
            budget
              ? `Daily model budget: $${budget.usedUsd.toFixed(4)} accounted + $${budget.heldUsd.toFixed(4)} reserved / $${budget.limitUsd.toFixed(2)}. Resets at 00:00 UTC.\nCompleted or rejected attempts today: ${budget.calls}.`
              : 'Daily model budget: disabled.',
            `Curated knowledge: ${options.knowledge?.topics.length || 0} topics. Use /knowledge for sources and review dates.`,
            'Conversation notes: /memory. Managers can remove a note with /forget.',
            failure
              ? `Last model failure since startup: ${failure.at}${failure.status ? ` (HTTP ${failure.status})` : ''}.`
              : 'Model failures since startup: none.'
          ].join('\n')
        )
      } else if (interaction.commandName === 'knowledge') {
        const query = interaction.options.getString('topic')
        const knowledge = options.knowledge
        if (!knowledge) {
          await respond('No curated guide is configured.')
          return
        }
        if (!query) {
          await respond(
            knowledge.topics
              .map((topic) => `**${topic.id}**: ${topic.title} (reviewed ${topic.reviewed})`)
              .join('\n')
          )
          return
        }
        const topic =
          knowledge.topics.find((topic) => topic.id === query) || knowledge.search(query, 1)[0]
        await respond(
          topic ? knowledge.format(topic) : 'No matching topic. Use /knowledge to see the index.'
        )
      } else {
        if (
          interaction.commandName === 'forget' &&
          !permissions.has(PermissionFlagsBits.ManageMessages)
        ) {
          await respond('Manage Messages permission is required to remove a saved note.')
          return
        }
        const id = interaction.options.getString('id')
        const text = await memoryQueue.run(async () => {
          const state = new PluginStateManager(options.cacheDir, 'notes')
          const { state: notes } = await state.getChannelState<Notes>(interaction.channelId)
          if (!notes?.notes.length) return 'No conversation notes are saved in this channel.'
          if (interaction.commandName === 'forget') {
            const count = notes.notes.length
            notes.notes = notes.notes.filter((note) => note.id !== id)
            if (notes.notes.length === count) return 'No note with that ID exists in this channel.'
            if (notes.preConsolidationBackup) notes.preConsolidationBackup.notes = []
            await state.setChannelState(interaction.channelId, notes)
            logger.info(
              { channelId: interaction.channelId, userId: interaction.user.id, noteId: id },
              'Manager removed conversation note'
            )
            return `Removed ${id} from active conversation memory. The curated guide is maintained separately.`
          }
          if (id) {
            const note = notes.notes.find((note) => note.id === id)
            if (!note) return 'No note with that ID exists in this channel.'
            const source =
              note.sourceUrls?.join('\n') ||
              (/^\d+$/.test(note.createdByMessageId)
                ? `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}/${note.createdByMessageId}`
                : 'Source unavailable for this older note.')
            return `${note.id} (saved ${note.createdAt})\nConversation memory, subject to verification.\n${note.content.slice(0, 1300)}\nSources: ${source.slice(0, 450)}`
          }
          const page = interaction.options.getInteger('page') || 1
          const slice = notes.notes.slice((page - 1) * 8, page * 8)
          return (
            `Conversation notes: ${notes.notes.length}. Page ${page}/${Math.ceil(notes.notes.length / 8)}. Use /memory id:<id> for content and sources.\n` +
            slice.map((note) => `**${note.id}**: ${note.content.slice(0, 150)}`).join('\n')
          )
        })
        await respond(text)
      }
    } catch (error) {
      logger.error({ err: error, command: interaction.commandName }, 'Discord control failed')
      if (interaction.deferred || interaction.replied)
        await interaction
          .editReply({
            content: 'This command could not complete. Please try again later.',
            allowedMentions: { parse: [] }
          })
          .catch(() => {})
    }
  })
}
