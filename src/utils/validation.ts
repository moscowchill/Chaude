/**
 * Validation utilities
 */

import { ConfigError } from '../types.js'

/**
 * Assert that a value is not null or undefined
 */
export function assertDefined<T>(
  value: T | null | undefined,
  message: string
): asserts value is T {
  if (value === null || value === undefined) {
    throw new ConfigError(message)
  }
}

/**
 * Validate that required environment variables are set
 */
export function validateEnv(vars: string[]): void {
  const missing = vars.filter((v) => !process.env[v])
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variables: ${missing.join(', ')}`
    )
  }
}

/**
 * Validate bot configuration
 */
export function validateBotConfig(config: any): void {
  const required = ['name', 'continuation_model']
  const missing = required.filter((field) => !config[field])
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required bot config fields: ${missing.join(', ')}`
    )
  }
}

/**
 * Clamp a number between min and max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Check if a string matches any pattern in an array (regex)
 */
export function matchesAny(str: string, patterns: string[]): boolean {
  return patterns.some((pattern) => new RegExp(pattern).test(str))
}

