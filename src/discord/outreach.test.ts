import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanDraft,
  DirectMessagesClosedError,
  loadOutreachConfig,
  namesMember,
  outreachCandidates,
  OutreachService,
  type IncomingDirectMessage,
  type OutreachChannelMessage,
  type OutreachComplete,
  type OutreachDiscord,
  type OutreachMember,
} from './outreach.js'
import { splitMessage } from './outreach-discord.js'
import outreachPlugin from '../tools/plugins/outreach.js'

vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const guildId = '11111111111111111'
const ownerId = '22222222222222222'
const memberId = '33333333333333333'
const otherId = '44444444444444444'
const botId = '55555555555555555'
const channelId = '66666666666666666'
const triggerId = '77777777777777777'
const dmChannelId = '88888888888888888'
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
/** 10:00 UTC, inside the sending window */
const T0 = Date.UTC(2026, 9, 8, 10)

const members: Record<string, OutreachMember> = {
  [ownerId]: { id: ownerId, name: 'Owner', username: 'owner', isBot: false },
  [memberId]: { id: memberId, name: 'Builder', username: 'builder', isBot: false },
  [otherId]: { id: otherId, name: 'Other', username: 'other', isBot: false },
  [botId]: { id: botId, name: 'Helper', username: 'helperbot', isBot: true },
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outreach-test-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const config = (env: Record<string, string> = {}) =>
  loadOutreachConfig({ OUTREACH_GUILD_ID: guildId, OUTREACH_OWNER_ID: ownerId, ...env }, dir)!

function fakeDiscord(overrides: Partial<OutreachDiscord> = {}) {
  const sent: Array<{ userId: string; content: string }> = []
  const reactions: string[] = []
  const discord: OutreachDiscord = {
    guildName: async () => 'Test Server',
    member: async (_guild, userId) => members[userId],
    findMembers: async (_guild, query) =>
      Object.values(members).filter((member) => member.username.startsWith(query)),
    message: async () => ({
      authorId: ownerId,
      content: `<@${botId}> ask builder, helperbot, owner or nobody how things are going`,
      mentions: [members[memberId]!],
    }),
    publicMessages: async () => [],
    sendDirect: async (userId, content) => {
      sent.push({ userId, content })
    },
    react: async (_channel, messageId, emoji) => {
      reactions.push(`${messageId}:${emoji}`)
    },
    ...overrides,
  }
  return { discord, sent, reactions }
}

function fakeModel(...replies: Array<Record<string, unknown>>) {
  const complete = vi.fn<OutreachComplete>()
  for (const reply of replies) {
    complete.mockResolvedValueOnce({ text: JSON.stringify(reply), stopReason: 'end_turn' })
  }
  return complete
}

function service(options: {
  discord: OutreachDiscord
  complete: OutreachComplete
  now?: () => number
  random?: () => number
  env?: Record<string, string>
}) {
  return new OutreachService({
    config: config(options.env),
    discord: options.discord,
    complete: options.complete,
    botName: 'Chaude',
    now: options.now ?? (() => T0),
    random: options.random ?? (() => 0),
  })
}

let dmCount = 0
const dm = (content: string, authorId = memberId): IncomingDirectMessage => ({
  id: `9000000000000000${dmCount++}`,
  channelId: dmChannelId,
  authorId,
  authorName: members[authorId]?.name ?? 'Someone',
  content,
  attachments: [],
})

const ask = (outreach: OutreachService, member = 'builder') =>
  outreach.ask({ channelId, messageId: triggerId, member, request: 'how the indexer is going' })

const QUESTION = 'Hi Builder! Owner asked me to check in: how is the indexer coming along?'

/** Delivers DMs and waits until the service has handled them */
async function deliver(outreach: OutreachService, ...messages: IncomingDirectMessage[]) {
  for (const message of messages) outreach.onDirectMessage(message)
  await vi.advanceTimersByTimeAsync(15_000)
  await outreach.idle()
}

const savedState = () =>
  JSON.parse(readFileSync(join(dir, 'member-outreach.json'), 'utf8')) as {
    threads: Record<string, { status: string; followUp?: string }>
    optedOut: Record<string, number>
  }

describe('member outreach config', () => {
  it('needs both IDs and bounds the numbers', () => {
    expect(loadOutreachConfig({}, dir)).toBeUndefined()
    expect(() => loadOutreachConfig({ OUTREACH_GUILD_ID: guildId }, dir)).toThrow()
    expect(() =>
      loadOutreachConfig({ OUTREACH_GUILD_ID: 'bad', OUTREACH_OWNER_ID: ownerId }, dir)
    ).toThrow()
    expect(() => config({ OUTREACH_DAILY_LIMIT: '9' })).toThrow()
    expect(() => config({ OUTREACH_COOLDOWN_DAYS: '1.5' })).toThrow()
    expect(config({ OUTREACH_DAILY_LIMIT: '0' }).dailyLimit).toBe(0)
    expect(config()).toMatchObject({
      questionModel: 'claude-sonnet-5-5',
      replyModel: 'claude-haiku-5-5',
      dailyLimit: 1,
      cooldownDays: 30,
    })
  })
})

describe('naming a member', () => {
  const member = { id: memberId, name: 'Data Wizard', username: 'wiz.dev', isBot: false }

  it('matches display names and usernames as whole words', () => {
    expect(namesMember('ask Data Wizard about it', member)).toBe(true)
    expect(namesMember('ping @wiz.dev please', member)).toBe(true)
    expect(namesMember('ASK WIZ.DEV', member)).toBe(true)
    expect(namesMember('ask wiz.developer', member)).toBe(false)
    expect(namesMember('ask the data wizards', member)).toBe(false)
    expect(namesMember('', member)).toBe(false)
  })
})

describe('drafted messages', () => {
  it('keep plain text and drop anything with links, invites or pings', () => {
    expect(cleanDraft('"How is it going?"')).toBe('How is it going?')
    expect(cleanDraft('See https://example.com')).toBeUndefined()
    expect(cleanDraft('Join discord.gg/abc')).toBeUndefined()
    expect(cleanDraft('Hey @everyone')).toBeUndefined()
    expect(cleanDraft('Ask <@123456789012345678>')).toBeUndefined()
    expect(cleanDraft('x'.repeat(1001))).toBeUndefined()
    expect(cleanDraft('  ')).toBeUndefined()
    expect(cleanDraft(42)).toBeUndefined()
  })

  it('are split at line breaks to fit Discord', () => {
    const parts = splitMessage(`${'a'.repeat(1500)}\n${'b'.repeat(1500)}`)
    expect(parts).toEqual(['a'.repeat(1500), 'b'.repeat(1500)])
    expect(splitMessage('x'.repeat(4000)).map((part) => part.length)).toEqual([1900, 1900, 200])
  })
})

describe('owner requests', () => {
  it('send a drafted question with the bot footer and wait for the answer', async () => {
    const { discord, sent } = fakeDiscord()
    const complete = fakeModel({ message: QUESTION })
    const result = await ask(service({ discord, complete }))

    expect(result).toContain(`Sent Builder this DM: "${QUESTION}"`)
    expect(sent).toEqual([
      {
        userId: memberId,
        content: `${QUESTION}\n\n-# I'm Chaude, a bot. Your reply goes to Owner. Reply "stop" and I won't message you again.`,
      },
    ])
    const request = complete.mock.calls[0]![0]
    expect(request).toMatchObject({ model: 'claude-sonnet-5-5', thinking: 'adaptive' })
    expect(request.outputSchema).toMatchObject({ required: ['message'] })
    expect(JSON.stringify(request.messages)).toContain('how the indexer is going')
    expect(savedState().threads[memberId]).toMatchObject({ status: 'open' })
  })

  it('come only from the owner, as Discord reports the triggering message', async () => {
    const { discord, sent } = fakeDiscord({
      message: async () => ({ authorId: otherId, content: 'ask builder', mentions: [members[memberId]!] }),
    })
    const complete = fakeModel({ message: QUESTION })
    const outreach = service({ discord, complete })

    expect(await ask(outreach)).toContain('Only the bot owner')
    expect(
      await outreach.ask({ channelId, messageId: '', member: 'builder', request: 'anything' })
    ).toContain('Only the bot owner')
    expect(complete).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })

  it('never go to bots, the owner or members who asked not to be messaged', async () => {
    vi.useFakeTimers()
    const { discord, sent } = fakeDiscord()
    const complete = fakeModel()
    const outreach = service({ discord, complete })

    expect(await ask(outreach, 'nobody')).toContain('not a member')
    expect(await ask(outreach, 'helperbot')).toContain('is a bot')
    expect(await ask(outreach, `<@${botId}>`)).toContain('is a bot')
    expect(await ask(outreach, 'owner')).toContain('That is you')
    await deliver(outreach, dm('stop'))
    expect(await ask(outreach)).toContain('asked me not to message them')
    expect(complete).not.toHaveBeenCalled()
    expect(sent.map((message) => message.content)).toEqual(["Got it, I won't message you again."])
  })

  it('drop a draft with a link and report closed DMs', async () => {
    const closed = fakeDiscord({
      sendDirect: async () => {
        throw new DirectMessagesClosedError()
      },
    })
    expect(
      await ask(service({ discord: closed.discord, complete: fakeModel({ message: QUESTION }) }))
    ).toContain("doesn't accept DMs")

    const { discord, sent } = fakeDiscord()
    const result = await ask(
      service({ discord, complete: fakeModel({ message: 'Read https://evil.example first' }) })
    )
    expect(result).toContain('unusable')
    expect(sent).toEqual([])
  })

  it('go only to a member the owner named, whoever the model picks', async () => {
    const { discord, sent } = fakeDiscord({
      message: async () => ({ authorId: ownerId, content: 'ask builder about the indexer', mentions: [] }),
    })
    const complete = fakeModel({ message: QUESTION })
    const outreach = service({ discord, complete })

    expect(await ask(outreach, 'other')).toContain("isn't mentioned or named")
    expect(complete).not.toHaveBeenCalled()
    expect(await ask(outreach, 'builder')).toContain('Sent Builder')
    expect(sent.map((message) => message.userId)).toEqual([memberId])
  })

  it('pick the mentioned member before searching by name', async () => {
    const findMembers = vi.fn(async () => [])
    const { discord, sent } = fakeDiscord({ findMembers })
    await ask(service({ discord, complete: fakeModel({ message: QUESTION }) }), '<@builder>')
    expect(findMembers).not.toHaveBeenCalled()
    expect(sent[0]?.userId).toBe(memberId)
  })

  it('stop at the daily limit', async () => {
    const { discord } = fakeDiscord()
    const complete = vi.fn<OutreachComplete>().mockResolvedValue({
      text: JSON.stringify({ message: QUESTION }),
      stopReason: 'end_turn',
    })
    const outreach = service({ discord, complete })
    for (let i = 0; i < 10; i++) expect(await ask(outreach)).toContain('Sent Builder')
    expect(await ask(outreach)).toContain('limit')
    expect(complete).toHaveBeenCalledTimes(10)
  })
})

describe('replies to a question', () => {
  it('reach the owner; the bot asks one follow-up at most, then thanks and closes', async () => {
    vi.useFakeTimers()
    const { discord, sent, reactions } = fakeDiscord()
    const complete = fakeModel(
      { message: QUESTION },
      { action: 'follow_up', message: 'Nice! What was the hardest part?', opt_out: false },
      { action: 'follow_up', message: 'Thanks, that helps!', opt_out: false }
    )
    const outreach = service({ discord, complete })
    await ask(outreach)

    await deliver(outreach, dm('Going well, we shipped v2 last week.'))
    expect(sent.slice(1)).toEqual([
      { userId: ownerId, content: `**Builder** answered:\n> ${QUESTION}\nGoing well, we shipped v2 last week.` },
      { userId: memberId, content: 'Nice! What was the hardest part?' },
    ])
    const replyRequest = complete.mock.calls[1]![0]
    expect(replyRequest).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 1024 })
    expect(replyRequest.thinking).toBeUndefined()
    expect(JSON.stringify(replyRequest.messages)).toContain('follow_up')

    await deliver(outreach, dm('The data migration.'))
    expect(sent.slice(3)).toEqual([
      {
        userId: ownerId,
        content: '**Builder** answered the follow-up:\n> Nice! What was the hardest part?\nThe data migration.',
      },
      { userId: memberId, content: 'Thanks, that helps!' },
    ])
    expect(JSON.stringify(complete.mock.calls[2]![0].messages)).toContain('Ask nothing.')
    expect(savedState().threads[memberId]).toMatchObject({ status: 'done' })

    // Later messages still reach the owner, with a reaction and no model call
    await deliver(outreach, dm('Oh, and the docs are up now.'))
    expect(sent.slice(5)).toEqual([
      { userId: ownerId, content: '**Builder** added:\nOh, and the docs are up now.' },
    ])
    expect(reactions).toHaveLength(1)
    expect(complete).toHaveBeenCalledTimes(3)
  })

  it('wait at most a minute for a member who keeps writing', async () => {
    vi.useFakeTimers()
    const { discord, sent } = fakeDiscord()
    const complete = fakeModel(
      { message: QUESTION },
      { action: 'acknowledge', message: 'Thanks!', opt_out: false }
    )
    const outreach = service({ discord, complete })
    await ask(outreach)
    for (let i = 0; i < 6; i++) {
      outreach.onDirectMessage(dm(`part ${i}`))
      await vi.advanceTimersByTimeAsync(10_000)
    }
    await outreach.idle()

    const relays = sent.filter((message) => message.userId === ownerId)
    expect(relays).toHaveLength(1)
    expect(relays[0]!.content).toContain('part 0\npart 1\npart 2\npart 3\npart 4\npart 5')
    outreach.stop()
  })

  it('read messages sent close together as one answer', async () => {
    vi.useFakeTimers()
    const { discord, sent } = fakeDiscord()
    const complete = fakeModel(
      { message: QUESTION },
      { action: 'acknowledge', message: 'Thanks!', opt_out: false }
    )
    const outreach = service({ discord, complete })
    await ask(outreach)
    outreach.onDirectMessage(dm('Going well.'))
    await vi.advanceTimersByTimeAsync(5_000)
    await deliver(outreach, dm('Shipping Friday.'))

    expect(sent.filter((message) => message.userId === ownerId)).toEqual([
      { userId: ownerId, content: `**Builder** answered:\n> ${QUESTION}\nGoing well.\nShipping Friday.` },
    ])
    expect(complete).toHaveBeenCalledTimes(2)
    expect(savedState().threads[memberId]).toMatchObject({ status: 'done' })
  })

  it('opt the member out when they say stop, and tell the owner', async () => {
    vi.useFakeTimers()
    const { discord, sent } = fakeDiscord()
    const outreach = service({ discord, complete: fakeModel({ message: QUESTION }) })
    await ask(outreach)
    await deliver(outreach, dm('Stop.'))

    expect(sent.slice(1)).toEqual([
      { userId: memberId, content: "Got it, I won't message you again." },
      { userId: ownerId, content: "**Builder** asked not to be messaged again, so I won't contact them." },
    ])
    await deliver(outreach, dm('hello?'))
    expect(sent).toHaveLength(3)
    expect(savedState().optedOut[memberId]).toBe(T0)
  })

  it('still thank the member and close when the reply model fails', async () => {
    vi.useFakeTimers()
    const { discord, sent } = fakeDiscord()
    const complete = fakeModel({ message: QUESTION })
    complete.mockRejectedValueOnce(new Error('budget exhausted'))
    const outreach = service({ discord, complete })
    await ask(outreach)
    await deliver(outreach, dm('All good here.'))

    expect(sent.at(-1)).toEqual({ userId: memberId, content: "Thanks! I've passed that on to Owner." })
    expect(savedState().threads[memberId]).toMatchObject({ status: 'done' })
  })

  it('are handled on shutdown instead of dropped', async () => {
    vi.useFakeTimers()
    const { discord, sent } = fakeDiscord()
    const outreach = service({
      discord,
      complete: fakeModel(
        { message: QUESTION },
        { action: 'acknowledge', message: 'Thanks!', opt_out: false }
      ),
    })
    await ask(outreach)
    outreach.onDirectMessage(dm('Answer right before a restart.'))
    outreach.stop()
    await outreach.idle()
    expect(sent.filter((message) => message.userId === ownerId)).toHaveLength(1)
  })

  it('get a daily pointer to the server when no question is open', async () => {
    vi.useFakeTimers()
    const { discord, sent } = fakeDiscord()
    const complete = fakeModel()
    const outreach = service({ discord, complete })
    await deliver(outreach, dm('hey bot', otherId))
    await deliver(outreach, dm('hello?', otherId))

    expect(sent).toEqual([
      { userId: otherId, content: "Hi! I only chat in the Test Server server. Mention me there and I'll reply." },
    ])
    expect(complete).not.toHaveBeenCalled()
  })
})

const talk = (authorId: string, count: number, at = T0 - DAY, isBot = false) =>
  Array.from({ length: count }, (_, i): OutreachChannelMessage => ({
    authorId,
    authorName: members[authorId]?.name ?? 'Someone',
    isBot,
    channelName: 'dev',
    content: `Working on the indexer rewrite, step ${i}: moving the block cache into its own service.`,
    createdAt: at + i * 1000,
  }))

describe('automatic questions', () => {
  it('pick members with enough recent public talk', () => {
    const messages = [
      ...talk(memberId, 6),
      ...talk(otherId, 2),
      ...talk(botId, 10, T0 - DAY, true),
      ...talk(ownerId, 6, T0 - 30 * DAY),
    ]
    const candidates = outreachCandidates(messages, T0 - 14 * DAY, () => false)
    expect(candidates.map((candidate) => candidate.id)).toEqual([memberId])
    expect(outreachCandidates(messages, T0 - 14 * DAY, (id) => id === memberId)).toEqual([])
  })

  it('ask one member a day inside the window and tell the owner', async () => {
    const { discord, sent } = fakeDiscord({
      publicMessages: async () => [...talk(memberId, 6), ...talk(ownerId, 6)],
    })
    const complete = fakeModel({
      ask: true,
      topic: 'the indexer rewrite',
      message: 'How is the indexer rewrite going?',
    })
    const outreach = service({ discord, complete })
    await outreach.tick()
    await outreach.tick()

    expect(sent).toEqual([
      {
        userId: memberId,
        content: `How is the indexer rewrite going?\n\n-# I'm Chaude, a bot. Your reply goes to Owner. Reply "stop" and I won't message you again.`,
      },
      {
        userId: ownerId,
        content: 'I asked **Builder** about the indexer rewrite:\n> How is the indexer rewrite going?',
      },
    ])
    const request = complete.mock.calls[0]![0]
    expect(request).toMatchObject({ model: 'claude-sonnet-5-5', thinking: 'adaptive' })
    expect(request.outputSchema).toMatchObject({ required: ['ask', 'topic', 'message'] })
    expect(JSON.stringify(request.messages)).toContain('[#dev, 2026-10-07] Working on the indexer')
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('skip members with nothing to ask about, up to three drafts a day', async () => {
    const people = ['40000000000000001', '40000000000000002', '40000000000000003', '40000000000000004']
    const { discord, sent } = fakeDiscord({
      member: async (_guild, userId) => ({ id: userId, name: 'Someone', username: 'someone', isBot: false }),
      publicMessages: async () => people.flatMap((id) => talk(id, 6)),
    })
    const complete = vi.fn<OutreachComplete>().mockResolvedValue({
      text: JSON.stringify({ ask: false, topic: '', message: '' }),
      stopReason: 'end_turn',
    })
    const outreach = service({ discord, complete })
    await outreach.tick()

    expect(complete).toHaveBeenCalledTimes(3)
    expect(sent).toEqual([])
  })

  it('leave a member alone during the cooldown', async () => {
    let now = T0
    const { discord, sent } = fakeDiscord({ publicMessages: async () => talk(memberId, 6, T0 - HOUR) })
    const complete = vi.fn<OutreachComplete>().mockResolvedValue({
      text: JSON.stringify({ ask: true, topic: 'the indexer', message: 'How is the indexer going?' }),
      stopReason: 'end_turn',
    })
    const outreach = service({ discord, complete, now: () => now })
    await outreach.tick()
    now = T0 + DAY
    await outreach.tick()

    expect(complete).toHaveBeenCalledTimes(1)
    expect(sent.filter((message) => message.userId === memberId)).toHaveLength(1)
  })

  it('stay off at a daily limit of 0 and outside the sending window', async () => {
    const publicMessages = vi.fn(async () => talk(memberId, 6))
    const { discord } = fakeDiscord({ publicMessages })
    await service({ discord, complete: fakeModel(), env: { OUTREACH_DAILY_LIMIT: '0' } }).tick()
    await service({ discord, complete: fakeModel(), now: () => Date.UTC(2026, 9, 8, 18) }).tick()
    expect(publicMessages).not.toHaveBeenCalled()
  })
})

describe('outreach state', () => {
  it('survives a restart', async () => {
    vi.useFakeTimers()
    const first = fakeDiscord()
    await ask(service({ discord: first.discord, complete: fakeModel({ message: QUESTION }) }))

    const { discord, sent } = fakeDiscord()
    const restarted = service({
      discord,
      complete: fakeModel({ action: 'acknowledge', message: 'Thanks!', opt_out: false }),
    })
    await deliver(restarted, dm('Going well.'))
    expect(sent[0]).toEqual({
      userId: ownerId,
      content: `**Builder** answered:\n> ${QUESTION}\nGoing well.`,
    })
  })

  it('pauses outreach when it is unreadable, so opt-outs are never lost', async () => {
    writeFileSync(join(dir, 'member-outreach.json'), '{"threads": "broken"}')
    const publicMessages = vi.fn(async () => talk(memberId, 6))
    const { discord, sent } = fakeDiscord({ publicMessages })
    const complete = fakeModel()
    const outreach = service({ discord, complete })

    expect(await ask(outreach)).toContain('paused')
    await outreach.tick()
    expect(publicMessages).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })
})

describe('ask_member tool', () => {
  const tool = outreachPlugin.tools[0]!
  const base = {
    botId,
    channelId,
    guildId,
    currentMessageId: triggerId,
    config: {},
    sendMessage: async () => [],
    pinMessage: async () => {},
  }

  it('passes the member and request through, or says outreach is off', async () => {
    const askMember = vi.fn(async () => 'Sent')
    expect(await tool.handler({ member: 'builder', request: 'status?' }, { ...base, askMember })).toBe('Sent')
    expect(askMember).toHaveBeenCalledWith('builder', 'status?')
    expect(await tool.handler({ member: 'builder', request: 'status?' }, base)).toContain('not set up')
  })
})
