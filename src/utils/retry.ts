/**
 * Retry utilities with exponential backoff
 */

import { logger } from './logger.js'

export interface RetryOptions {
  maxAttempts: number
  initialDelay?: number
  maxDelay?: number
  exponential?: boolean
  onRetry?: (error: Error, attempt: number) => void
}

/**
 * Retry a function with configurable backoff
 */
export async function retryWithBackoff<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    maxAttempts,
    initialDelay = 1000,
    maxDelay = 32000,
    exponential = true,
    onRetry
  } = options

  let lastError: Error | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error as Error

      if (attempt === maxAttempts) {
        break
      }

      // Call retry callback if provided
      if (onRetry) {
        onRetry(lastError, attempt)
      }

      // Calculate delay
      let delay = initialDelay
      if (exponential) {
        delay = Math.min(initialDelay * Math.pow(2, attempt - 1), maxDelay)
      }

      logger.warn(
        {
          error: lastError.message,
          attempt,
          maxAttempts,
          delayMs: delay
        },
        'Retrying after error'
      )

      await sleep(delay)
    }
  }

  throw lastError
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Retry for LLM calls (no exponential backoff, fixed retry count)
 */
export async function retryLLM<T>(fn: () => Promise<T>, maxAttempts: number): Promise<T> {
  return retryWithBackoff(fn, {
    maxAttempts,
    initialDelay: 1000,
    exponential: false
  })
}

/** Providers may wrap SDK failures in LLMError.details. */
function errorDetails(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') return {}
  const object = error as Record<string, unknown>
  return object.details && typeof object.details === 'object'
    ? (object.details as Record<string, unknown>)
    : object
}

export function llmErrorStatus(error: unknown): number | undefined {
  const status = errorDetails(error).status
  return typeof status === 'number' ? status : undefined
}

export function isTransientLLMError(error: unknown): boolean {
  const details = errorDetails(error)
  const status = llmErrorStatus(error)
  if (status !== undefined) return [408, 429, 500, 502, 503, 504, 529].includes(status)
  return (
    ['APIConnectionError', 'APIConnectionTimeoutError'].includes(String(details.name)) ||
    ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(String(details.code))
  )
}

export async function retryLLMWithRateLimit<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= maxAttempts || !isTransientLLMError(error)) throw error
      const headers = errorDetails(error).headers as Record<string, string> | Headers | undefined
      const value =
        headers instanceof Headers ? headers.get('retry-after') : headers?.['retry-after']
      const seconds = value ? Number(value) : NaN
      const retryAfter = value
        ? Number.isFinite(seconds)
          ? seconds * 1000
          : Date.parse(value) - Date.now()
        : NaN
      // Hand long waits back to the caller, without retrying ahead of the server.
      if (retryAfter > 30_000) throw error
      const delayMs = Math.max(
        1000 * 2 ** (attempt - 1),
        Number.isFinite(retryAfter) ? retryAfter : 0
      )
      logger.warn(
        { attempt, status: llmErrorStatus(error), delayMs },
        'Retrying transient LLM failure'
      )
      await sleep(Math.min(delayMs, 30_000))
    }
  }
}

/**
 * Retry for Discord API calls (exponential backoff with cap)
 */
export async function retryDiscord<T>(
  fn: () => Promise<T>,
  maxBackoffMs: number = 32000
): Promise<T> {
  return retryWithBackoff(fn, {
    maxAttempts: 10, // Generous retry count for Discord
    initialDelay: 1000,
    maxDelay: maxBackoffMs,
    exponential: true
  })
}
