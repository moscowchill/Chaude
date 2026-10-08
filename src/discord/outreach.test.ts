import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  asksToStop,
  bestMatches,
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
  who,
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
const devChannelId = '67000000000000001'
/** A channel members talk in that the bot may not post in */
const quietChannelId = '67000000000000002'
const newsChannelId = '67000000000000003'
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
  const posts: Array<{ channelId: string; content: string; mentionUserId: string }> = []
  const replies: Array<{ channelId: string; messageId: string; content: string }> = []
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
      addressesBot: true,
    }),
    publicMessages: async () => [],
    sendDirect: async (userId, content) => {
      sent.push({ userId, content })
    },
    channels: async (_guild, name) =>
      [
        { id: channelId, name: 'general' },
        { id: devChannelId, name: 'dev' },
        { id: newsChannelId, name: 'news', announcement: true },
      ].filter((c) => name.trim() === `<#${c.id}>` || name.replace(/^#/, '').toLowerCase() === c.name),
    sendToChannel: async (channelId, content, mentionUserId) => {
      posts.push({ channelId, content, mentionUserId })
      return [`9200000000000000${posts.length}`]
    },
    replyInChannel: async (channelId, messageId, content) => {
      replies.push({ channelId, messageId, content })
    },
    canSee: async () => true,
    react: async (_channel, messageId, emoji) => {
      reactions.push(`${messageId}:${emoji}`)
    },
    ...overrides,
  }
  return { discord, sent, posts, replies, reactions }
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
  authorUsername: members[authorId]?.username ?? 'someone',
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

describe('asking to stop', () => {
  it.each([
    'stop',
    'Stop.',
    'STOP!!',
    'please stop',
    'stop it',
    'stop messaging me',
    'stop dming me',
    "don't message me again",
    'never contact me again',
    'no more messages please',
    'remove me',
    'not interested, stop',
    'Please leave me alone',
    'ok\nstop',
    'Thanks!\nplease stop messaging me',
    'pls stop',
    'unsub',
    'go away',
  ])('catches %j', (text) => {
    expect(asksToStop(text)).toBe(true)
  })

  it.each([
    'We had to stop the node before the migration.',
    'It stopped crashing after the fix.',
    'Going well, shipping Friday.',
    'No more blockers, the indexer is done.',
    'The bug did not go away until the restart.',
    'Unsubscribed from the noisy feed, it helped.',
    'ok\nthanks',
  ])('lets an answer through: %j', (text) => {
    expect(asksToStop(text)).toBe(false)
  })
})

describe('member labels for the owner', () => {
  it('drop markdown from display names and add the username', () => {
    expect(who('**Owner**', 'mallory')).toBe('**Owner** (`@mallory`)')
    expect(who('a_b `c`\n# d', 'ab.c')).toBe('**ab c d** (`@ab.c`)')
    expect(who('***', 'only_user')).toBe('**only_user** (`@only_user`)')
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

    expect(result).toContain(`Sent **Builder** (\`@builder\`) this DM: "${QUESTION}"`)
    expect(sent).toEqual([
      {
        userId: memberId,
        content: `${QUESTION}\n\n-# I'm Chaude, a bot. Replies here are shared with Owner. Reply "stop" and I won't message you again.`,
      },
    ])
    const request = complete.mock.calls[0]![0]
    expect(request).toMatchObject({ model: 'claude-sonnet-5-5', thinking: 'adaptive' })
    expect(request.outputSchema).toMatchObject({ required: ['message'] })
    expect(JSON.stringify(request.messages)).toContain('how the indexer is going')
    expect(JSON.stringify(request.messages)).toContain('as your own question, without saying who wanted to know')
    expect(savedState().threads[memberId]).toMatchObject({ status: 'open' })
  })

  it('come only from the owner, as Discord reports the triggering message', async () => {
    const { discord, sent } = fakeDiscord({
      message: async () => ({
        authorId: otherId,
        content: 'ask builder',
        mentions: [members[memberId]!],
        addressesBot: true,
      }),
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
      message: async () => ({
        authorId: ownerId,
        content: 'ask builder about the indexer',
        mentions: [],
        addressesBot: true,
      }),
    })
    const complete = fakeModel({ message: QUESTION })
    const outreach = service({ discord, complete })

    expect(await ask(outreach, 'other')).toContain("isn't mentioned or named")
    expect(complete).not.toHaveBeenCalled()
    expect(await ask(outreach, 'builder')).toContain('Sent **Builder** (`@builder`)')
    expect(sent.map((message) => message.userId)).toEqual([memberId])
  })

  it('need a message addressed to the bot', async () => {
    const { discord, sent } = fakeDiscord({
      message: async () => ({
        authorId: ownerId,
        content: 'builder said the indexer is nearly done',
        mentions: [],
        addressesBot: false,
      }),
    })
    const complete = fakeModel({ message: QUESTION })
    expect(await ask(service({ discord, complete }))).toContain('Mention me or reply to me')
    expect(complete).not.toHaveBeenCalled()
    expect(sent).toEqual([])
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
    for (let i = 0; i < 10; i++) expect(await ask(outreach)).toContain('Sent **Builder** (`@builder`)')
    expect(await ask(outreach)).toContain('limit')
    expect(complete).toHaveBeenCalledTimes(10)
  })
})

const command = (member: string, question: string, channel = '') => ({
  action: 'ask',
  member,
  question,
  channel,
})

describe('owner requests by DM', () => {
  it('ask a loosely named member by DM and confirm what was sent', async () => {
    vi.useFakeTimers()
    const { discord, sent } = fakeDiscord()
    const complete = fakeModel(command('build', 'how the indexer is going'), { message: QUESTION })
    const outreach = service({ discord, complete })
    await deliver(outreach, dm('ask build how the indexer is going', ownerId))

    const reader = complete.mock.calls[0]![0]
    expect(reader).toMatchObject({ model: 'claude-haiku-5-5' })
    expect(reader.outputSchema).toMatchObject({ required: ['action', 'member', 'question', 'channel'] })
    expect(complete.mock.calls[1]![0]).toMatchObject({ model: 'claude-sonnet-5-5' })
    expect(sent).toEqual([
      {
        userId: memberId,
        content: `${QUESTION}\n\n-# I'm Chaude, a bot. Replies here are shared with Owner. Reply "stop" and I won't message you again.`,
      },
      {
        userId: ownerId,
        content: `Sent **Builder** (\`@builder\`) this DM: "${QUESTION}" Their answer will come to you by DM.`,
      },
    ])
    expect(savedState().threads[memberId]).toMatchObject({ status: 'open' })
  })

  it('ask in a named channel, pinging only that member', async () => {
    vi.useFakeTimers()
    const { discord, sent, posts } = fakeDiscord()
    const complete = fakeModel(command('builder', 'how their day is going', 'general'), {
      message: 'How is your day going?',
    })
    const outreach = service({ discord, complete })
    await deliver(outreach, dm('ask builder how their day is going in #general', ownerId))

    expect(posts).toEqual([
      {
        channelId,
        content: `<@${memberId}> How is your day going?`,
        mentionUserId: memberId,
      },
    ])
    const publicPrompt = JSON.stringify(complete.mock.calls[1]![0].messages)
    expect(publicPrompt).toContain('#general channel')
    expect(publicPrompt).toContain('as your own question, without saying who wanted to know')
    expect(sent).toEqual([
      {
        userId: ownerId,
        content: 'Asked **Builder** (`@builder`) in #general: "How is your day going?"',
      },
    ])
    expect(savedState().threads[memberId]).toBeUndefined()
    // A "stop" reply to the owner's channel question opts out too
    expect(
      outreach.onChannelReply({
        id: '93000000000000002',
        channelId,
        authorId: memberId,
        authorName: 'Builder',
        authorUsername: 'builder',
        content: 'stop',
        replyToId: '92000000000000001',
      })
    ).toBe(true)
  })

  it('find a member by a display name seen only in recent public messages', async () => {
    vi.useFakeTimers()
    const novaId = '45000000000000001'
    const nova = { id: novaId, name: 'Nova Dev', username: 'nv_77', isBot: false }
    const { discord, sent } = fakeDiscord({
      member: async (_guild, userId) => (userId === novaId ? nova : members[userId]),
      findMembers: async () => [],
      publicMessages: async () => [
        {
          authorId: novaId,
          authorName: 'Nova Dev',
          authorUsername: 'nv_77',
          isBot: false,
          channelId: devChannelId,
          channelName: 'dev',
          content: 'Shipping the indexer today.',
          createdAt: T0 - HOUR,
        },
      ],
    })
    const outreach = service({
      discord,
      complete: fakeModel(command('novadev', 'how the release went'), { message: QUESTION }),
    })
    await deliver(outreach, dm('ask novadev how the release went', ownerId))
    expect(sent[0]?.userId).toBe(novaId)
  })

  it('list the candidates when a name matches several members', async () => {
    vi.useFakeTimers()
    const { discord, sent } = fakeDiscord({
      findMembers: async () => [
        members[memberId]!,
        { id: otherId, name: 'Buildmaster', username: 'buildmaster', isBot: false },
      ],
    })
    const complete = fakeModel(command('build', 'how it is going'))
    const outreach = service({ discord, complete })
    await deliver(outreach, dm('ask build how it is going', ownerId))

    expect(sent).toEqual([
      {
        userId: ownerId,
        content:
          'Several members match "build": **Builder** (`@builder`), **Buildmaster** (`@buildmaster`). Ask again with the exact username. Nothing was sent.',
      },
    ])
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('answer with help when the request is unclear or names someone the owner never wrote', async () => {
    vi.useFakeTimers()
    const { discord, sent } = fakeDiscord()
    const complete = fakeModel(
      { action: 'unclear', member: '', question: '', channel: '' },
      command('other', 'anything')
    )
    const outreach = service({ discord, complete })
    await deliver(outreach, dm('hmm can you do the thing', ownerId))
    await deliver(outreach, dm('ask builder about the indexer', ownerId))

    expect(sent.map((message) => message.userId)).toEqual([ownerId, ownerId])
    expect(sent.every((message) => message.content.startsWith('To have me ask someone'))).toBe(true)
  })

  it('stay private unless the owner wrote "in #channel", whatever channel the model returns', async () => {
    vi.useFakeTimers()
    const { discord, sent, posts } = fakeDiscord()
    const complete = fakeModel(
      command('builder', 'how the release went', 'general'),
      { message: QUESTION },
      command('builder', 'about the outage', 'general'),
      { message: QUESTION }
    )
    const outreach = service({ discord, complete })
    await deliver(outreach, dm('ask builder how the release went', ownerId))
    await deliver(outreach, dm('ask builder about the #general outage', ownerId))

    expect(posts).toEqual([])
    expect(sent.filter((message) => message.userId === memberId)).toHaveLength(2)
  })

  it('trust a loose name only right after "ask"; elsewhere it must be exact', async () => {
    vi.useFakeTimers()
    const v2Id = '45000000000000002'
    const v2 = { id: v2Id, name: 'V2 Dev', username: 'v2_dev', isBot: false }
    const { discord, sent } = fakeDiscord({
      member: async (_guild, userId) => (userId === v2Id ? v2 : members[userId]),
      findMembers: async () => [...Object.values(members), v2],
    })
    const complete = fakeModel(
      command('v2', 'how the release went'),
      command('builder', 'how it is going'),
      { message: QUESTION }
    )
    const outreach = service({ discord, complete })
    // The model picked "v2" out of the question: it is not where the owner put the name
    await deliver(outreach, dm('ask builder how the v2 release went', ownerId))
    // No "ask <name>" form, but an exact username: fine
    await deliver(outreach, dm('can you check with builder how it is going', ownerId))

    expect(sent[0]).toEqual({
      userId: ownerId,
      content: '"v2" only partly matches **V2 Dev** (`@v2_dev`). Ask again with the exact username. Nothing was sent.',
    })
    expect(sent.slice(1).map((message) => message.userId)).toEqual([memberId, ownerId])
  })

  it('refuse a channel the member cannot see', async () => {
    vi.useFakeTimers()
    const { discord, sent, posts } = fakeDiscord({ canSee: async () => false })
    const outreach = service({
      discord,
      complete: fakeModel(command('builder', 'how it is going', 'general')),
    })
    await deliver(outreach, dm('ask builder how it is going in #general', ownerId))
    expect(posts).toEqual([])
    expect(sent).toEqual([
      {
        userId: ownerId,
        content: "**Builder** (`@builder`) can't see #general, so a mention there would go unseen. Nothing was sent.",
      },
    ])
  })

  it('say so when the channel is unknown', async () => {
    vi.useFakeTimers()
    const { discord, sent, posts } = fakeDiscord()
    const outreach = service({
      discord,
      complete: fakeModel(command('builder', 'how it is going', 'random')),
    })
    await deliver(outreach, dm('ask builder how it is going in #random', ownerId))
    expect(posts).toEqual([])
    expect(sent).toEqual([
      { userId: ownerId, content: "I can't find a #random channel I can post in. Nothing was sent." },
    ])
  })

  it('never come from anyone else', async () => {
    vi.useFakeTimers()
    const { discord, sent } = fakeDiscord()
    const complete = fakeModel(command('builder', 'anything'))
    const outreach = service({ discord, complete })
    await deliver(outreach, dm('ask builder how the indexer is going', otherId))

    expect(complete).not.toHaveBeenCalled()
    expect(sent.map((message) => message.userId)).toEqual([otherId])
  })

  it('count toward the daily limit', async () => {
    vi.useFakeTimers()
    const { discord, sent } = fakeDiscord()
    const complete = vi.fn<OutreachComplete>(async (request) => ({
      text: JSON.stringify(
        JSON.stringify(request.messages).includes('sent it this direct message')
          ? command('builder', 'how it is going')
          : { message: QUESTION }
      ),
      stopReason: 'end_turn',
    }))
    const outreach = service({ discord, complete })
    for (let i = 0; i < 10; i++) await ask(outreach)
    await deliver(outreach, dm('ask builder how it is going', ownerId))
    expect(sent.at(-1)).toEqual({
      userId: ownerId,
      content: "Today's limit of 10 member questions is reached. Nothing was sent.",
    })
  })
})

describe('matching a loosely typed name', () => {
  const people = [
    { id: '1', name: 'Builder', username: 'bob.builds', isBot: false },
    { id: '2', name: 'Bob', username: 'builder', isBot: false },
    { id: '3', name: 'Nova Dev', username: 'nv_77', isBot: false },
    { id: '4', name: 'Builder Bot', username: 'builderbot', isBot: true },
  ]
  const ids = (query: string) => bestMatches(query, people).members.map((member) => member.id)

  it('prefers an exact username or display name, then a prefix, then a part', () => {
    // Two different members match exactly, by display name and by username: the owner picks
    expect(ids('builder')).toEqual(['1', '2'])
    expect(ids('Nova Dev')).toEqual(['3'])
    expect(ids('novadev')).toEqual(['3'])
    expect(ids('bob')).toEqual(['2'])
    expect(ids('bo')).toEqual(['1', '2'])
    expect(ids('77')).toEqual(['3'])
    expect(ids('zzz')).toEqual([])
    expect(ids('@!')).toEqual([])
    expect(bestMatches('nova dev', people).exact).toBe(true)
    expect(bestMatches('nova', people).exact).toBe(false)
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
      { userId: ownerId, content: `**Builder** (\`@builder\`) answered:\n> ${QUESTION}\nGoing well, we shipped v2 last week.` },
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
        content: '**Builder** (`@builder`) answered the follow-up:\n> Nice! What was the hardest part?\nThe data migration.',
      },
      { userId: memberId, content: 'Thanks, that helps!' },
    ])
    expect(JSON.stringify(complete.mock.calls[2]![0].messages)).toContain('Ask nothing.')
    expect(savedState().threads[memberId]).toMatchObject({ status: 'done' })

    // Later messages still reach the owner, with a reaction and no model call
    await deliver(outreach, dm('Oh, and the docs are up now.'))
    expect(sent.slice(5)).toEqual([
      { userId: ownerId, content: '**Builder** (`@builder`) added:\nOh, and the docs are up now.' },
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
      { userId: ownerId, content: `**Builder** (\`@builder\`) answered:\n> ${QUESTION}\nGoing well.\nShipping Friday.` },
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
      {
        userId: ownerId,
        content: "**Builder** (`@builder`) asked not to be messaged again, so I won't contact them. They wrote:\n> Stop.",
      },
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

  it('stay silent to the owner when a DM needs no action', async () => {
    vi.useFakeTimers()
    const { discord, sent } = fakeDiscord()
    const complete = fakeModel({ action: 'none', member: '', question: '', channel: '' })
    const outreach = service({ discord, complete })
    await deliver(outreach, dm('thanks for passing that on', ownerId))
    expect(sent).toEqual([])
    expect(complete).toHaveBeenCalledTimes(1)
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

const talk = (
  authorId: string,
  count: number,
  at = T0 - DAY,
  isBot = false,
  channel = { id: devChannelId, name: 'dev' }
) =>
  Array.from({ length: count }, (_, i): OutreachChannelMessage => ({
    authorId,
    authorName: members[authorId]?.name ?? 'Someone',
    authorUsername: members[authorId]?.username ?? 'someone',
    isBot,
    channelId: channel.id,
    channelName: channel.name,
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

  it('ask one member a day in the public channel they talk in, and tell the owner', async () => {
    const { discord, sent, posts } = fakeDiscord({
      publicMessages: async () => [...talk(memberId, 6), ...talk(ownerId, 6)],
    })
    const complete = fakeModel({
      ask: true,
      channel: 'dev',
      topic: 'the indexer rewrite',
      message: 'How is the indexer rewrite going?',
    })
    const outreach = service({ discord, complete })
    await outreach.tick()
    await outreach.tick()

    expect(posts).toEqual([
      {
        channelId: devChannelId,
        content: `<@${memberId}> How is the indexer rewrite going?`,
        mentionUserId: memberId,
      },
    ])
    expect(sent).toEqual([
      {
        userId: ownerId,
        content: 'I asked **Builder** (`@builder`) in #dev about the indexer rewrite:\n> How is the indexer rewrite going?',
      },
    ])
    const request = complete.mock.calls[0]![0]
    expect(request).toMatchObject({ model: 'claude-sonnet-5-5', thinking: 'adaptive' })
    expect(request.outputSchema).toMatchObject({ required: ['ask', 'channel', 'topic', 'message'] })
    expect(JSON.stringify(request.messages)).toContain('[#dev, 2026-10-07] Working on the indexer')
    expect(JSON.stringify(request.messages)).toContain('in a public channel')
    expect(savedState().threads[memberId]).toBeUndefined()
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('post only in a channel the member used and the bot may post in', async () => {
    const { discord, posts } = fakeDiscord({
      publicMessages: async () => [
        ...talk(memberId, 4, T0 - DAY, false, { id: quietChannelId, name: 'announcements' }),
        ...talk(memberId, 2, T0 - HOUR),
      ],
    })
    // The model names a channel the member never posted in
    const complete = fakeModel({ ask: true, channel: 'general', topic: 'the indexer', message: 'How is it going?' })
    await service({ discord, complete }).tick()

    // Their busiest channel refuses posts, so it lands in the next one they use
    expect(posts.map((post) => post.channelId)).toEqual([devChannelId])
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

  it('skip announcement channels and channels the member can no longer see', async () => {
    const { discord, posts } = fakeDiscord({
      publicMessages: async () => [
        ...talk(memberId, 4, T0 - DAY, false, { id: newsChannelId, name: 'news' }),
        ...talk(memberId, 3, T0 - DAY, false, { id: channelId, name: 'general' }),
        ...talk(memberId, 2, T0 - HOUR),
      ],
      canSee: async (id) => id !== channelId,
    })
    const complete = fakeModel({ ask: true, channel: 'news', topic: 'the indexer', message: 'How is it going?' })
    await service({ discord, complete }).tick()
    expect(posts.map((post) => post.channelId)).toEqual([devChannelId])
  })

  it('let the member opt out by replying "stop" to the question in the channel', async () => {
    const { discord, sent, posts, replies } = fakeDiscord({
      publicMessages: async () => talk(memberId, 6, T0 - HOUR),
    })
    const complete = fakeModel({ ask: true, channel: 'dev', topic: 'the indexer', message: 'How is it going?' })
    const outreach = service({ discord, complete })
    await outreach.tick()
    expect(posts).toHaveLength(1)
    const postId = '92000000000000001'
    const reply = (authorId: string, content: string, replyToId = postId) => ({
      id: '93000000000000001',
      channelId: devChannelId,
      authorId,
      authorName: members[authorId]!.name,
      authorUsername: members[authorId]!.username,
      content,
      replyToId,
    })

    // An answer, someone else's "stop" and a reply to another message stay normal chat
    expect(outreach.onChannelReply(reply(memberId, 'Going well, shipping Friday.'))).toBe(false)
    expect(outreach.onChannelReply(reply(otherId, 'stop'))).toBe(false)
    expect(outreach.onChannelReply(reply(memberId, 'stop', '92000000000000099'))).toBe(false)

    expect(outreach.onChannelReply(reply(memberId, 'please stop pinging me'))).toBe(true)
    await outreach.idle()
    expect(replies).toEqual([
      { channelId: devChannelId, messageId: '93000000000000001', content: "Got it, I won't ask you again." },
    ])
    expect(sent.at(-1)).toEqual({
      userId: ownerId,
      content:
        "**Builder** (`@builder`) asked not to be asked again, so I won't contact them. They wrote:\n> please stop pinging me",
    })
    expect(savedState().optedOut[memberId]).toBe(T0)
  })

  it('count the question before sending, so a failed send means no second one that day', async () => {
    let now = T0
    const sendToChannel = vi.fn(async () => {
      throw new Error('network down')
    })
    const { discord } = fakeDiscord({ publicMessages: async () => talk(memberId, 6, T0 - HOUR), sendToChannel })
    const complete = vi.fn<OutreachComplete>().mockResolvedValue({
      text: JSON.stringify({ ask: true, topic: 'the indexer', message: 'How is the indexer going?' }),
      stopReason: 'end_turn',
    })
    const outreach = service({ discord, complete, now: () => now })
    await outreach.tick()
    now = T0 + 2 * HOUR
    await outreach.tick()
    expect(complete).toHaveBeenCalledTimes(1)
    expect(sendToChannel).toHaveBeenCalledTimes(1)
  })

  it('leave a member alone during the cooldown', async () => {
    let now = T0
    const { discord, posts } = fakeDiscord({ publicMessages: async () => talk(memberId, 6, T0 - HOUR) })
    const complete = vi.fn<OutreachComplete>().mockResolvedValue({
      text: JSON.stringify({ ask: true, topic: 'the indexer', message: 'How is the indexer going?' }),
      stopReason: 'end_turn',
    })
    const outreach = service({ discord, complete, now: () => now })
    await outreach.tick()
    now = T0 + DAY
    await outreach.tick()

    expect(complete).toHaveBeenCalledTimes(1)
    expect(posts).toHaveLength(1)
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
      content: `**Builder** (\`@builder\`) answered:\n> ${QUESTION}\nGoing well.`,
    })
  })

  it('tells the owner once that outreach is paused', async () => {
    vi.useFakeTimers()
    writeFileSync(join(dir, 'member-outreach.json'), '{"threads": "broken"}')
    const { discord, sent } = fakeDiscord()
    const complete = fakeModel()
    const outreach = service({ discord, complete })
    await deliver(outreach, dm('ask builder how it is going', ownerId))
    await deliver(outreach, dm('hello?', ownerId))
    await deliver(outreach, dm('hi', otherId))

    expect(sent).toEqual([
      {
        userId: ownerId,
        content: 'Member outreach is paused because its saved state is unreadable or unwritable. Check the bot logs.',
      },
    ])
    expect(complete).not.toHaveBeenCalled()
  })

  it('loads a state file from before automatic questions moved to channels', async () => {
    writeFileSync(
      join(dir, 'member-outreach.json'),
      JSON.stringify({
        day: '',
        requests: 0,
        automatic: { sent: 0, drafts: 0, nextAt: null },
        threads: {},
        optedOut: {},
        dmsClosed: {},
        autoReplies: {},
      })
    )
    const { discord } = fakeDiscord()
    expect(await ask(service({ discord, complete: fakeModel({ message: QUESTION }) }))).toContain('Sent')
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
