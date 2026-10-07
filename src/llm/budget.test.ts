import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DailyBudget } from './budget.js'
import type { LLMProvider, ProviderRequest } from './middleware.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chaude-budget-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})
const request: ProviderRequest = {
  model: 'claude-haiku-4-5-20251001',
  messages: [],
  max_tokens: 1000,
  temperature: 0,
  top_p: 1
}
function provider(): LLMProvider {
  return {
    name: 'anthropic',
    supportedModes: ['chat'],
    countInputTokens: vi.fn().mockResolvedValue(100),
    complete: vi.fn().mockResolvedValue({
      content: [],
      model: request.model,
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 20, cacheCreationTokens: 30, cacheReadTokens: 50 }
    })
  }
}
const file = () => join(dir, 'spending.json')

describe('persistent daily model budget', () => {
  it('meters cache tokens and survives a restart', async () => {
    await new DailyBudget(file(), 2).complete(provider(), request)
    const status = await new DailyBudget(file(), 2).status()
    expect(status).toMatchObject({ usedUsd: 0.000265, heldUsd: 0, limitUsd: 2, calls: 1 })
  })
  it('reserves before generation and rejects concurrent overspending', async () => {
    const p = provider()
    let finish!: (value: unknown) => void
    p.complete = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const budget = new DailyBudget(file(), 0.01)
    const first = budget.complete(p, request)
    await vi.waitFor(() => expect(p.complete).toHaveBeenCalledTimes(1))
    expect((await new DailyBudget(file(), 0.01).status()).heldUsd).toBeGreaterThan(0.007)
    await expect(budget.complete(p, request)).rejects.toThrow('too little')
    expect(p.complete).toHaveBeenCalledTimes(1)
    finish({ content: [], stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } })
    await first
    expect((await budget.status()).heldUsd).toBe(0)
  })
  it('keeps reservations for ambiguous failures and missing usage', async () => {
    const p = provider()
    p.complete = vi.fn().mockRejectedValue(new Error('connection lost'))
    const budget = new DailyBudget(file(), 2)
    await expect(budget.complete(p, request)).rejects.toThrow('connection lost')
    const held = (await budget.status()).heldUsd
    expect(held).toBeGreaterThan(0)
    p.complete = vi.fn().mockResolvedValue({ content: [] })
    await budget.complete(p, request)
    expect((await new DailyBudget(file(), 2).status()).heldUsd).toBe(held * 2)
  })
  it('refunds known rejected requests and blocks unknown pricing/providers', async () => {
    const p = provider()
    p.complete = vi.fn().mockRejectedValue({ details: { status: 400 } })
    const budget = new DailyBudget(file(), 2)
    await expect(budget.complete(p, request)).rejects.toMatchObject({ details: { status: 400 } })
    expect((await budget.status()).heldUsd).toBe(0)
    await expect(budget.complete(p, { ...request, model: 'unknown' })).rejects.toThrow(
      'verified pricing'
    )
    await expect(budget.complete({ ...p, name: 'openrouter' }, request)).rejects.toThrow(
      'verified pricing'
    )
    expect(p.complete).toHaveBeenCalledTimes(1)
  })
  it('changes day at UTC midnight and settles an earlier call against its original day', async () => {
    let now = new Date('2026-10-01T23:59:59Z')
    const budget = new DailyBudget(file(), 2, {}, () => now)
    const p = provider()
    const complete = p.complete
    p.complete = async (r) => {
      now = new Date('2026-10-02T00:00:01Z')
      return complete(r)
    }
    await budget.complete(p, request)
    expect(await budget.status()).toMatchObject({ day: '2026-10-02', usedUsd: 0, heldUsd: 0 })
    const ledger = JSON.parse(await readFile(file(), 'utf8'))
    expect(ledger.days['2026-10-01'].charged).toBe(265)
  })
  it('fails closed on a corrupted ledger or invalid accounting input', async () => {
    await writeFile(file(), '{broken')
    const p = provider()
    await expect(new DailyBudget(file(), 2).complete(p, request)).rejects.toThrow('ledger')
    expect(p.complete).not.toHaveBeenCalled()
    await writeFile(
      file(),
      JSON.stringify({ version: 1, days: { '2026-10-01': { charged: -1, calls: 0, held: {} } } })
    )
    await expect(new DailyBudget(file(), 2).status()).rejects.toThrow('ledger')
    expect(() => new DailyBudget(file(), NaN)).toThrow()
    await writeFile(file(), JSON.stringify({ version: 1, days: [] }))
    await expect(new DailyBudget(file(), 2).status()).rejects.toThrow('ledger')
  })
  describe('Claude Haiku 5.5 rate cards', () => {
    const haiku = { ...request, model: 'claude-haiku-5-5' }
    function used(usage: Record<string, number>, counted = 100): LLMProvider {
      const p = provider()
      p.countInputTokens = vi.fn().mockResolvedValue(counted)
      p.complete = vi.fn().mockResolvedValue({ content: [], stopReason: 'end_turn', usage })
      return p
    }
    it('charges prompts up to 100,000 tokens at the short-prompt rates', async () => {
      const usage = { inputTokens: 1000, outputTokens: 100, cacheCreationTokens: 2000, cacheReadTokens: 10000 }
      await new DailyBudget(file(), 2).complete(used(usage), haiku)
      // 1000 x 0.10 + 100 x 0.50 + 2000 x 0.20 + 10000 x 0.01 micro-dollars
      expect((await new DailyBudget(file(), 2).status()).usedUsd).toBe(0.00065)
    })
    it('charges a longer prompt, cache reads included, at the long-prompt rates', async () => {
      const usage = { inputTokens: 1000, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 100_000 }
      await new DailyBudget(file(), 2).complete(used(usage), haiku)
      // 1000 x 0.50 + 100 x 2.50 + 100000 x 0.05 micro-dollars
      expect((await new DailyBudget(file(), 2).status()).usedUsd).toBe(0.00575)
    })
    it('reserves a counted long prompt at the long-prompt rates', async () => {
      const p = used({ inputTokens: 0, outputTokens: 0 }, 120_000)
      // (126000 + 1024) x 1.00 + 1000 x 2.50 = $0.1295 reserved; the short card would hold $0.026
      await expect(new DailyBudget(file(), 0.1).complete(p, haiku)).rejects.toThrow('too little')
      expect(p.complete).not.toHaveBeenCalled()
    })
    it('rejects an invalid long-prompt card', () => {
      const bad = { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 }
      expect(() => new DailyBudget(file(), 2, { m: { ...bad, longPrompt: { ...bad, overTokens: 0 } } })).toThrow(
        'Invalid model pricing'
      )
      expect(() => new DailyBudget(file(), 2, { m: { ...bad, longPrompt: { ...bad, output: 0, overTokens: 5 } } })).toThrow(
        'Invalid model pricing'
      )
    })
  })
})
