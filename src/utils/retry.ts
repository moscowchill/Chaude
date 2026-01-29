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
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const {
    maxAttempts,
    initialDelay = 1000,
    maxDelay = 32000,
    exponential = true,
    onRetry,
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
          delayMs: delay,
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
export async function retryLLM<T>(
  fn: () => Promise<T>,
  maxAttempts: number
): Promise<T> {
  return retryWithBackoff(fn, {
    maxAttempts,
    initialDelay: 1000,
    exponential: false,
  })
}

/**
 * Type guard helpers for safe property access on unknown error objects
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function hasProperty<K extends string>(obj: Record<string, unknown>, key: K): obj is Record<K, unknown> {
  return key in obj
}

/**
 * Extract retry-after duration from a rate limit error.
 * Returns undefined if not a rate limit error or no retry-after header.
 * Uses type guards for safe property access instead of brittle type assertions.
 */
function extractRetryAfter(error: unknown): number | undefined {
  // Safely navigate the error object structure
  if (!isObject(error)) {
    return undefined
  }

  if (!hasProperty(error, 'details') || !isObject(error.details)) {
    return undefined
  }

  const details = error.details
  const status = hasProperty(details, 'status') ? details.status : undefined
  const headers = hasProperty(details, 'headers') && isObject(details.headers) ? details.headers : undefined

  // Extract nested error type: details.error.error.type
  let errorType: unknown
  if (hasProperty(details, 'error') && isObject(details.error)) {
    const errorObj = details.error
    if (hasProperty(errorObj, 'error') && isObject(errorObj.error)) {
      const innerError = errorObj.error
      if (hasProperty(innerError, 'type')) {
        errorType = innerError.type
      }
    }
  }

  // Check if it's a rate limit error
  if (status !== 429 && errorType !== 'rate_limit_error') {
    return undefined
  }

  // Try to extract retry-after header
  if (headers && hasProperty(headers, 'retry-after')) {
    const retryAfterStr = headers['retry-after']
    if (typeof retryAfterStr === 'string') {
      const seconds = parseInt(retryAfterStr, 10)
      if (!isNaN(seconds) && seconds > 0) {
        return seconds * 1000 // Convert to milliseconds
      }
    }
  }

  return undefined
}

/**
 * Retry for LLM calls with rate-limit awareness.
 * Respects retry-after header from 429 responses instead of fixed backoff.
 */
export async function retryLLMWithRateLimit<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3
): Promise<T> {
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error as Error

      if (attempt === maxAttempts) {
        break
      }

      // Check for rate limit with retry-after
      const retryAfterMs = extractRetryAfter(error)

      if (retryAfterMs !== undefined) {
        // Rate limit - wait the specified duration
        // Cap at 5 minutes to avoid extremely long waits
        const waitMs = Math.min(retryAfterMs, 5 * 60 * 1000)

        logger.warn(
          {
            error: lastError.message,
            attempt,
            maxAttempts,
            retryAfterMs,
            waitMs,
          },
          'Rate limited - waiting before retry'
        )

        await sleep(waitMs)
      } else {
        // Not a rate limit or no retry-after - use short fixed delay
        const delayMs = 1000

        logger.warn(
          {
            error: lastError.message,
            attempt,
            maxAttempts,
            delayMs,
          },
          'Retrying after error'
        )

        await sleep(delayMs)
      }
    }
  }

  throw lastError
}

/**
 * Retry for Discord API calls (exponential backoff with cap)
 */
export async function retryDiscord<T>(
  fn: () => Promise<T>,
  maxBackoffMs: number = 32000
): Promise<T> {
  return retryWithBackoff(fn, {
    maxAttempts: 10,  // Generous retry count for Discord
    initialDelay: 1000,
    maxDelay: maxBackoffMs,
    exponential: true,
  })
}

