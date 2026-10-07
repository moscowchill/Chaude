import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { atomicJson, SerialQueue } from '../utils/atomic-state.js'
import type { LLMCompletion } from '../types.js'
import type { LLMProvider, ProviderRequest } from './middleware.js'
import { llmErrorStatus } from '../utils/retry.js'
import { logger } from '../utils/logger.js'

export class BudgetError extends Error {}
export interface RateCard {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}
export interface ModelPrice extends RateCard {
  /** Higher rates for prompts over `overTokens` input tokens, cache reads and writes included */
  longPrompt?: RateCard & { overTokens: number }
}
const RATE_KEYS = ['input', 'output', 'cacheWrite', 'cacheRead'] as const
// USD per million tokens, checked against Anthropic pricing on 2026-10-07.
// Cache writes use the conservative one-hour rate.
const PRICES: Record<string, ModelPrice> = {
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheWrite: 0.2,
    cacheRead: 0.01,
    longPrompt: { overTokens: 100_000, input: 0.5, output: 2.5, cacheWrite: 1, cacheRead: 0.05 }
  },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheWrite: 2, cacheRead: 0.1 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 2, cacheRead: 0.1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 8, cacheRead: 0.2 },
  // Opus 4.8 and 4.7 can answer an Opus 5.5 request through the server-side fallback
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 10, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheWrite: 10, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite: 10, cacheRead: 0.5 },
  // The pricing page lists Sonnet 5.5 cache reads at $0.20 in its table and $0.10 in its
  // caching section; the guard reserves the higher figure
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 4, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 6, cacheRead: 0.3 }
}
/** The rates that apply to a prompt of `promptTokens` input tokens */
function rateCard(price: ModelPrice, promptTokens: number): RateCard {
  return price.longPrompt && promptTokens > price.longPrompt.overTokens ? price.longPrompt : price
}
interface Day {
  charged: number
  held: Record<string, number>
  calls: number
}
interface Ledger {
  version: 1
  days: Record<string, Day>
}

export class DailyBudget {
  private queue = new SerialQueue()
  readonly limitMicros: number
  private prices: Record<string, ModelPrice>

  constructor(
    private file: string,
    limitUsd: number,
    prices: Record<string, ModelPrice> = {},
    private now: () => Date = () => new Date()
  ) {
    if (!Number.isFinite(limitUsd) || limitUsd < 0) throw new Error('Invalid DAILY_BUDGET_USD')
    this.limitMicros = Math.floor(limitUsd * 1_000_000)
    if (!Number.isSafeInteger(this.limitMicros)) throw new Error('Invalid DAILY_BUDGET_USD')
    // An override merges into the built-in entry, so overriding a model's base rates
    // keeps its long-prompt card
    this.prices = { ...PRICES }
    for (const [model, price] of Object.entries(prices)) {
      this.prices[model] = { ...PRICES[model], ...price }
    }
    for (const price of Object.values(this.prices)) {
      const long = price.longPrompt
      if (long && (!Number.isSafeInteger(long.overTokens) || long.overTokens <= 0))
        throw new Error('Invalid model pricing')
      for (const card of long ? [price, long] : [price]) {
        for (const key of RATE_KEYS) {
          if (!Number.isFinite(card[key]) || card[key] <= 0)
            throw new Error('Invalid model pricing')
        }
      }
    }
  }

  private async read(): Promise<Ledger> {
    let value: Ledger
    try {
      value = JSON.parse(await fs.readFile(this.file, 'utf8')) as Ledger
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, days: {} }
      throw new BudgetError('The spending ledger needs operator attention.')
    }
    if (
      value.version !== 1 ||
      !value.days ||
      typeof value.days !== 'object' ||
      Array.isArray(value.days)
    )
      throw new BudgetError('Invalid spending ledger.')
    for (const day of Object.values(value.days)) {
      if (
        !day ||
        !day.held ||
        typeof day.held !== 'object' ||
        Array.isArray(day.held) ||
        !Number.isSafeInteger(day.calls) ||
        day.calls < 0 ||
        [day.charged, ...Object.values(day.held)].some((n) => !Number.isSafeInteger(n) || n < 0)
      ) {
        throw new BudgetError('Invalid spending ledger.')
      }
    }
    return value
  }

  async status(): Promise<{
    day: string
    usedUsd: number
    heldUsd: number
    limitUsd: number
    calls: number
  }> {
    return this.queue.run(async () => {
      const day = this.now().toISOString().slice(0, 10)
      const entry = (await this.read()).days[day]
      return {
        day,
        usedUsd: (entry?.charged || 0) / 1_000_000,
        heldUsd: Object.values(entry?.held || {}).reduce((a, b) => a + b, 0) / 1_000_000,
        limitUsd: this.limitMicros / 1_000_000,
        calls: entry?.calls || 0
      }
    })
  }

  async complete(provider: LLMProvider, request: ProviderRequest): Promise<LLMCompletion> {
    const price = Object.hasOwn(this.prices, request.model) ? this.prices[request.model] : undefined
    if (provider.name !== 'anthropic' || !provider.countInputTokens || !price) {
      throw new BudgetError('This model needs verified pricing and token counting before use.')
    }
    if (!Number.isSafeInteger(request.max_tokens) || request.max_tokens <= 0)
      throw new BudgetError('Invalid output token limit.')
    const available = await this.status()
    if (available.usedUsd + available.heldUsd >= available.limitUsd) {
      throw new BudgetError('My daily model budget is used up. It resets at 00:00 UTC.')
    }
    const tokens = await provider.countInputTokens(request)
    if (!Number.isSafeInteger(tokens) || tokens < 0)
      throw new BudgetError('Input token counting failed.')
    // Counting can differ slightly from billing. Reserve padding and maximum output,
    // with every input token charged at the highest configured input/cache rate.
    const padded = Math.ceil(tokens * 1.05) + 1024
    const reserveRates = rateCard(price, padded)
    const reserve = Math.ceil(
      padded * Math.max(reserveRates.input, reserveRates.cacheWrite, reserveRates.cacheRead) +
        request.max_tokens * reserveRates.output
    )
    const id = randomUUID()
    const day = this.now().toISOString().slice(0, 10)
    await this.queue.run(async () => {
      const ledger = await this.read()
      const entry = (ledger.days[day] ||= { charged: 0, held: {}, calls: 0 })
      const held = Object.values(entry.held).reduce((a, b) => a + b, 0)
      if (entry.charged + held + reserve > this.limitMicros) {
        throw new BudgetError(
          'There is too little daily model budget left for this request. It resets at 00:00 UTC.'
        )
      }
      entry.held[id] = reserve
      // Retain a month of totals. Persist reservations before any paid call.
      for (const date of Object.keys(ledger.days).sort().slice(0, -31)) delete ledger.days[date]
      await atomicJson(this.file, ledger)
    })

    let completion: LLMCompletion
    try {
      completion = await provider.complete(request)
    } catch (error) {
      const status = llmErrorStatus(error)
      // A rejected request has no generation. Ambiguous network/server failures
      // keep their reservation, including across process restarts.
      if (status && status >= 400 && status < 500 && status !== 408) await this.settle(day, id, 0)
      throw error
    }
    const usage = completion.usage
    if (
      usage &&
      [
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheCreationTokens || 0,
        usage.cacheReadTokens || 0
      ].every((n) => Number.isSafeInteger(n) && n >= 0)
    ) {
      // A server-side fallback can answer with another model: charge what answered
      // when its price is known
      const answered =
        completion.model && Object.hasOwn(this.prices, completion.model)
          ? this.prices[completion.model]
          : price
      if (completion.model && completion.model !== request.model && !Object.hasOwn(this.prices, completion.model)) {
        logger.warn(
          { requested: request.model, answered: completion.model },
          'Answering model has no price entry: charged at the requested model price'
        )
      }
      const rates = rateCard(
        answered ?? price,
        usage.inputTokens + (usage.cacheCreationTokens || 0) + (usage.cacheReadTokens || 0)
      )
      const cost = Math.ceil(
        usage.inputTokens * rates.input +
          usage.outputTokens * rates.output +
          (usage.cacheCreationTokens || 0) * rates.cacheWrite +
          (usage.cacheReadTokens || 0) * rates.cacheRead
      )
      await this.settle(day, id, cost)
    }
    return completion
  }

  private async settle(day: string, id: string, cost: number): Promise<void> {
    await this.queue.run(async () => {
      const ledger = await this.read()
      const entry = ledger.days[day]
      if (!entry || !Object.hasOwn(entry.held, id))
        throw new BudgetError('Missing spending reservation.')
      entry.charged += cost
      entry.calls++
      delete entry.held[id]
      await atomicJson(this.file, ledger)
    })
  }
}
