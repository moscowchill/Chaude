/**
 * Structured logging with pino
 * Supports per-activation file logging with async context tracking
 * Also captures logs to the active trace for debugging
 */

import pino from 'pino'
import { AsyncLocalStorage } from 'async_hooks'
import { existsSync, mkdirSync, createWriteStream } from 'fs'
import { join } from 'path'
import { traceLog, getCurrentTrace } from '../trace/collector.js'
import type { LogEntry } from '../trace/types.js'

const isDevelopment = process.env.NODE_ENV !== 'production'
const logDir = process.env.LOG_DIR || './logs/activations'

// Ensure log directory exists
if (!existsSync(logDir)) {
  mkdirSync(logDir, { recursive: true })
}

// Base logger for console output
const baseLogger = pino({
  level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
})

// General log file for non-activation logs
const generalLogPath = join(logDir, 'general.log')
const generalLogStream = createWriteStream(generalLogPath, { flags: 'a' })
const generalFileLogger = pino({
  level: 'debug',
}, generalLogStream)

// Async context storage for tracking which activation we're in
interface ActivationContext {
  logger: pino.Logger
  id: string
}

const activationContext = new AsyncLocalStorage<ActivationContext>()

// Map to track all active activation loggers
const activationLoggers = new Map<string, { logger: pino.Logger, stream: NodeJS.WritableStream }>()

/**
 * Main logger - routes to console + file + trace (if active)
 */
export const logger = new Proxy(baseLogger, {
  get(target, prop: string) {
    if (['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(prop)) {
      return (...args: unknown[]) => {
        // Log to console - use Reflect.apply to preserve 'this' context
        const logMethod = Reflect.get(target, prop, target) as ((...args: unknown[]) => void)
        Reflect.apply(logMethod, target, args)

        // Log to file - check async context first
        const context = activationContext.getStore()
        if (context?.logger) {
          // Inside activation - log to activation file
          const activationLogMethod = Reflect.get(context.logger, prop, context.logger) as ((...args: unknown[]) => void)
          Reflect.apply(activationLogMethod, context.logger, args)
        } else {
          // Outside activation - log to general file
          const fileLogMethod = Reflect.get(generalFileLogger, prop, generalFileLogger) as ((...args: unknown[]) => void)
          Reflect.apply(fileLogMethod, generalFileLogger, args)
        }

        // Also capture to trace if we're inside an activation
        const trace = getCurrentTrace()
        if (trace) {
          // Parse the pino-style arguments
          // pino allows: logger.info(obj, msg) or logger.info(msg)
          let message: string
          let data: Record<string, unknown> | undefined

          if (typeof args[0] === 'object' && args[0] !== null) {
            data = args[0] as Record<string, unknown>
            message = String(args[1] || '')
          } else {
            message = String(args[0] || '')
          }

          traceLog(prop as LogEntry['level'], message, data)
        }
      }
    }
    return Reflect.get(target, prop, target)
  }
})

/**
 * Run a function with activation-specific logging context
 */
export async function withActivationLogging<T>(
  channelId: string,
  messageId: string,
  fn: () => Promise<T>
): Promise<T> {
  const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0]
  const filename = `${channelId}-${messageId}-${timestamp}.log`
  const filePath = join(logDir, filename)
  const activationId = `${channelId}:${messageId}`
  
  const stream = createWriteStream(filePath, { flags: 'a' })
  const activationLogger = pino({
    level: 'debug',
  }, stream)
  
  activationLoggers.set(activationId, { logger: activationLogger, stream })
  
  logger.debug({ channelId, messageId, logFile: filename }, 'Started activation logging')
  
  try {
    // Run the function with this activation's context
    return await activationContext.run(
      { logger: activationLogger, id: activationId },
      fn
    )
  } finally {
    logger.debug({ activationId }, 'Stopped activation logging')
    
    // Clean up
    const entry = activationLoggers.get(activationId)
    if (entry) {
      entry.stream.end()
      activationLoggers.delete(activationId)
    }
  }
}

/**
 * Legacy functions for backward compatibility (now no-ops since we use withActivationLogging)
 */
export function startActivationLogging(_channelId: string, _messageId: string): void {
  // No-op - using withActivationLogging instead
}

export function stopActivationLogging(): void {
  // No-op - using withActivationLogging instead
}

/**
 * Create a child logger with additional context
 */
export function createLogger(context: Record<string, unknown>) {
  return logger.child(context)
}

/**
 * Log levels for convenience
 */
export const log = {
  trace: logger.trace.bind(logger),
  debug: logger.debug.bind(logger),
  info: logger.info.bind(logger),
  warn: logger.warn.bind(logger),
  error: logger.error.bind(logger),
  fatal: logger.fatal.bind(logger),
}

