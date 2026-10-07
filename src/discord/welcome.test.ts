import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadWelcomeConfig, WelcomeService, type WelcomeMember } from './welcome.js'

vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

const guildId = '11111111111111111'
const channelId = '22222222222222222'
const userId = '33333333333333333'
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'welcome-test-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})
const member = (): WelcomeMember => ({
  guildId,
  userId,
  isBot: false,
  pending: false,
  joinedTimestamp: Date.now()
})
const config = () =>
  loadWelcomeConfig({ WELCOME_GUILD_ID: guildId, WELCOME_CHANNEL_ID: channelId }, dir)!

describe('member welcomes', () => {
  it('requires both IDs and bounds the rendered message', () => {
    expect(loadWelcomeConfig({}, dir)).toBeUndefined()
    expect(() => loadWelcomeConfig({ WELCOME_GUILD_ID: guildId }, dir)).toThrow()
    expect(() =>
      loadWelcomeConfig({ WELCOME_GUILD_ID: 'bad', WELCOME_CHANNEL_ID: channelId }, dir)
    ).toThrow()
    expect(() =>
      loadWelcomeConfig(
        {
          WELCOME_GUILD_ID: guildId,
          WELCOME_CHANNEL_ID: channelId,
          WELCOME_MESSAGE: '{user}'.repeat(100)
        },
        dir
      )
    ).toThrow()
  })

  it('sends one greeting for concurrent duplicate events and persists it across restarts', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const service = new WelcomeService(config(), send)
    const joinEvent = member()
    await Promise.all([service.welcome(joinEvent), service.welcome(joinEvent)])
    await new WelcomeService(config(), send).welcome(joinEvent)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toMatchObject({
      guildId,
      channelId,
      userId,
      content: `Welcome, <@${userId}>! Glad you're here. What brings you to the server?`
    })
    expect(send.mock.calls[0][0].nonce).toHaveLength(24)
  })

  it('skips bots, other guilds, screening-pending members and historical joins', async () => {
    const send = vi.fn()
    const service = new WelcomeService(config(), send)
    for (const override of [
      { isBot: true },
      { guildId: '44444444444444444' },
      { pending: true },
      { joinedTimestamp: null },
      { joinedTimestamp: Date.now() - 31 * 86400000 }
    ]) {
      await service.welcome({ ...member(), ...override })
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('greets after screening is complete, and greets a later rejoin', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const service = new WelcomeService(config(), send)
    const joinEvent = member()
    await service.welcome({ ...joinEvent, pending: true })
    await service.welcome(joinEvent)
    await service.welcome({ ...joinEvent, joinedTimestamp: joinEvent.joinedTimestamp! + 1000 })
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0][0].nonce).not.toBe(send.mock.calls[1][0].nonce)
  })

  it('allows a failed delivery to be retried', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(undefined)
    const service = new WelcomeService(config(), send)
    const joinEvent = member()
    await service.welcome(joinEvent)
    await service.welcome(joinEvent)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0][0].nonce).toBe(send.mock.calls[1][0].nonce)
  })

  it('pauses welcomes if deduplication state is corrupt', async () => {
    writeFileSync(config().statePath, 'broken json')
    const send = vi.fn()
    await new WelcomeService(config(), send).welcome(member())
    expect(send).not.toHaveBeenCalled()
  })
})
