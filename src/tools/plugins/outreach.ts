/**
 * Outreach Plugin
 *
 * Lets the bot owner have the bot DM a server member a question. The answer goes back
 * to the owner by DM. The member outreach service (src/discord/outreach.ts) does the
 * work and refuses anyone other than the configured owner.
 */

import { ToolPlugin } from './types.js'

const outreachPlugin: ToolPlugin = {
  name: 'outreach',
  description: "Ask server members questions by DM on the owner's behalf",
  tools: [
    {
      name: 'ask_member',
      description:
        "Send a server member a private question by DM for the person asking you; their answer goes back to that person by DM. Only the bot's owner can have you do this, and it refuses anyone else. Use it when the owner asks you to ask, check with or ping someone privately.",
      inputSchema: {
        type: 'object',
        properties: {
          member: {
            type: 'string',
            description: 'Who to ask: their @mention, username or display name',
          },
          request: {
            type: 'string',
            description: 'What to ask them, in the words of the person asking you',
          },
        },
        required: ['member', 'request'],
      },
      handler: async (input: { member?: unknown; request?: unknown }, context) => {
        if (!context.askMember) return 'Messaging members is not set up on this bot.'
        return context.askMember(String(input.member ?? ''), String(input.request ?? ''))
      },
    },
  ],
}

export default outreachPlugin
