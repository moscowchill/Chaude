import { afterEach, describe, expect, it, vi } from 'vitest'
import { retryLLMWithRateLimit } from './retry.js'

afterEach(() => vi.useRealTimers())
describe('LLM retry policy', () => {
  it.each([400, 401, 402, 403, 404, 422])(
    'does not retry permanent HTTP %s errors',
    async (status) => {
      const fn = vi.fn().mockRejectedValue({ details: { status } })
      await expect(retryLLMWithRateLimit(fn)).rejects.toMatchObject({ details: { status } })
      expect(fn).toHaveBeenCalledTimes(1)
    }
  )
  it('retries transient failures within a bounded attempt count', async () => {
    vi.useFakeTimers()
    const fn = vi.fn().mockRejectedValueOnce({ status: 529 }).mockResolvedValue('ok')
    const result = retryLLMWithRateLimit(fn)
    await vi.runAllTimersAsync()
    expect(await result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it('respects Retry-After and leaves long waits to the caller', async () => {
    vi.useFakeTimers()
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 429, headers: new Headers({ 'retry-after': '2' }) })
      .mockResolvedValue('ok')
    const result = retryLLMWithRateLimit(fn)
    await vi.advanceTimersByTimeAsync(1999)
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toBe('ok')
    const long = vi
      .fn()
      .mockRejectedValue({ details: { status: 429, headers: { 'retry-after': '120' } } })
    await expect(retryLLMWithRateLimit(long)).rejects.toBeTruthy()
    expect(long).toHaveBeenCalledTimes(1)
  })
})
