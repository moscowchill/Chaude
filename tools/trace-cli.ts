#!/usr/bin/env npx tsx
/**
 * Trace CLI - Navigate and inspect activation traces
 * 
 * Usage:
 *   ./tools/trace-cli.ts list [--channel <id>] [--failed] [--limit N]
 *   ./tools/trace-cli.ts show <traceId>
 *   ./tools/trace-cli.ts outline <traceId>
 *   ./tools/trace-cli.ts explain <traceId>                  <- Full debugging view
 *   ./tools/trace-cli.ts message <traceId> <position>
 *   ./tools/trace-cli.ts raw <traceId> [messageId]          <- Raw Discord messages
 *   ./tools/trace-cli.ts logs <traceId>                     <- Console logs from activation
 *   ./tools/trace-cli.ts tokens <traceId>
 *   ./tools/trace-cli.ts find-message <discordMessageId>
 *   ./tools/trace-cli.ts diff <traceId1> <traceId2>
 *   ./tools/trace-cli.ts request <traceId> [callIndex]
 *   ./tools/trace-cli.ts response <traceId> [callIndex]
 */

import { readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { ActivationTrace, ContextMessageInfo, TraceIndex } from '../src/trace/types.js'

const TRACE_DIR = process.env.TRACE_DIR || './logs/traces'
const BODIES_DIR = join(TRACE_DIR, 'bodies')
const INDEX_FILE = join(TRACE_DIR, 'index.jsonl')

// ============================================================================
// Helpers
// ============================================================================

function loadTrace(traceId: string): ActivationTrace | null {
  const files = readdirSync(TRACE_DIR).filter(f => f.includes(traceId) && f.endsWith('.json') && f !== 'index.jsonl')
  if (files.length === 0) return null
  const content = readFileSync(join(TRACE_DIR, files[0]!), 'utf-8')
  return JSON.parse(content)
}

function loadIndex(): (TraceIndex & { filename: string })[] {
  if (!existsSync(INDEX_FILE)) return []
  return readFileSync(INDEX_FILE, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function truncate(s: string, len: number): string {
  if (s.length <= len) return s
  return s.slice(0, len - 3) + '...'
}

// ============================================================================
// Commands
// ============================================================================

function cmdList(args: string[]): void {
  let channel: string | undefined
  let failed = false
  let limit = 20
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--channel' && args[i + 1]) {
      channel = args[++i]
    } else if (args[i] === '--failed') {
      failed = true
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[++i]!, 10)
    }
  }
  
  let entries = loadIndex().reverse().slice(0, 500)
  
  if (channel) {
    entries = entries.filter(e => e.channelId === channel)
  }
  if (failed) {
    entries = entries.filter(e => !e.success)
  }
  
  entries = entries.slice(0, limit)
  
  console.log(`\n  Traces (${entries.length} shown)\n`)
  console.log('  ID        Time      Channel            LLM   Tools   Tokens    Status')
  console.log('  ─────────────────────────────────────────────────────────────────────')
  
  for (const entry of entries) {
    const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false })
    const status = entry.success ? '✓' : '✗'
    const channelShort = entry.channelId.slice(-8)
    
    console.log(
      `  ${entry.traceId.padEnd(10)} ${time}  ${channelShort.padEnd(18)} ` +
      `${String(entry.llmCallCount).padStart(3)}   ${String(entry.toolExecutionCount).padStart(5)}   ` +
      `${formatTokens(entry.totalTokens).padStart(6)}    ${status}`
    )
  }
  console.log()
}

function cmdShow(traceId: string): void {
  const trace = loadTrace(traceId)
  if (!trace) {
    console.error(`Trace ${traceId} not found`)
    process.exit(1)
  }
  
  console.log(JSON.stringify(trace, null, 2))
}

function cmdOutline(traceId: string): void {
  const trace = loadTrace(traceId)
  if (!trace) {
    console.error(`Trace ${traceId} not found`)
    process.exit(1)
  }
  
  const cb = trace.contextBuild
  if (!cb) {
    console.log('No context build info in this trace')
    return
  }
  
  const totalTokens = cb.tokenEstimates.total
  
  console.log()
  console.log(`┌─ Trace ${trace.traceId} ─────────────────────────────────────────────────`)
  console.log(`│ Channel: ${trace.channelId}`)
  console.log(`│ Trigger: ${trace.activation?.reason} (msg: ${trace.triggeringMessageId})`)
  console.log(`│ Time: ${new Date(trace.timestamp).toISOString()}`)
  console.log(`│ Duration: ${formatDuration(trace.durationMs || 0)}`)
  console.log(`│`)
  console.log(`│ Context: ${cb.messagesIncluded} messages, ~${formatTokens(totalTokens)} tokens`)
  if (cb.didTruncate) {
    console.log(`│ ⚠ Truncated: ${cb.messagesRolledOff} messages rolled off (${cb.truncateReason})`)
  }
  console.log(`│`)
  console.log(`│ Token breakdown:`)
  console.log(`│   System:   ${formatTokens(cb.tokenEstimates.system).padStart(6)} (${((cb.tokenEstimates.system / totalTokens) * 100).toFixed(1)}%)`)
  console.log(`│   Messages: ${formatTokens(cb.tokenEstimates.messages).padStart(6)} (${((cb.tokenEstimates.messages / totalTokens) * 100).toFixed(1)}%)`)
  console.log(`│   Images:   ${formatTokens(cb.tokenEstimates.images).padStart(6)} (${((cb.tokenEstimates.images / totalTokens) * 100).toFixed(1)}%)`)
  console.log(`│   Tools:    ${formatTokens(cb.tokenEstimates.tools).padStart(6)} (${((cb.tokenEstimates.tools / totalTokens) * 100).toFixed(1)}%)`)
  console.log(`│`)
  console.log(`│ Messages:`)
  console.log(`│ ─────────────────────────────────────────────────────────────────────`)
  
  // Group messages into chunks for display
  const messages = cb.messages
  let lastParticipant = ''
  
  for (const msg of messages) {
    if (!msg.contentLength && !msg.hasImages) continue  // Skip empty messages
    
    const pos = String(msg.position).padStart(3)
    const participant = msg.participant.slice(0, 12).padEnd(12)
    const tokens = formatTokens(msg.tokenEstimate).padStart(5)
    const preview = truncate(msg.contentPreview.replace(/\n/g, ' '), 40)
    
    let flags = ''
    if (msg.isTrigger) flags += ' ← TRIGGER'
    if (msg.hasCacheControl) flags += ' [CACHE]'
    if (msg.hasImages) flags += ` [${msg.imageCount} img]`
    
    if (msg.participant !== lastParticipant) {
      console.log(`│`)
    }
    console.log(`│ ${pos}. ${participant} ${tokens}tk  ${preview}${flags}`)
    lastParticipant = msg.participant
  }
  
  console.log(`│`)
  console.log(`│ LLM Calls: ${trace.llmCalls.length}`)
  for (const call of trace.llmCalls) {
    const tokens = `${formatTokens(call.tokenUsage.inputTokens)} in / ${formatTokens(call.tokenUsage.outputTokens)} out`
    console.log(`│   #${call.depth}: ${formatDuration(call.durationMs)} - ${call.response.stopReason} (${tokens})`)
    if (call.response.toolUseCount > 0) {
      console.log(`│      → ${call.response.toolUseCount} tool call(s)`)
    }
  }
  
  if (trace.toolExecutions.length > 0) {
    console.log(`│`)
    console.log(`│ Tool Executions: ${trace.toolExecutions.length}`)
    for (const tool of trace.toolExecutions) {
      console.log(`│   ${tool.toolName}: ${formatDuration(tool.durationMs)}`)
      console.log(`│     in:  ${truncate(JSON.stringify(tool.input), 60)}`)
      console.log(`│     out: ${truncate(tool.output, 60)}${tool.outputTruncated ? ' [truncated]' : ''}`)
    }
  }
  
  console.log(`│`)
  if (trace.outcome) {
    const status = trace.outcome.success ? '✓ Success' : '✗ Failed'
    console.log(`│ Outcome: ${status}`)
    if (trace.outcome.success) {
      console.log(`│   Response: ${truncate(trace.outcome.responseText.replace(/\n/g, ' '), 60)}`)
      console.log(`│   Sent: ${trace.outcome.messagesSent} message(s)`)
    } else if (trace.outcome.error) {
      console.log(`│   Error: ${trace.outcome.error.message}`)
      console.log(`│   Phase: ${trace.outcome.error.phase}`)
    }
  }
  console.log(`└──────────────────────────────────────────────────────────────────────`)
  console.log()
}

function cmdMessage(traceId: string, position: string): void {
  const trace = loadTrace(traceId)
  if (!trace) {
    console.error(`Trace ${traceId} not found`)
    process.exit(1)
  }
  
  const pos = parseInt(position, 10)
  const msg = trace.contextBuild?.messages.find(m => m.position === pos)
  
  if (!msg) {
    console.error(`Message at position ${pos} not found`)
    process.exit(1)
  }
  
  console.log()
  console.log(`Message #${pos}`)
  console.log(`─────────────────────────────────────────────`)
  console.log(`Participant: ${msg.participant}`)
  console.log(`Discord ID:  ${msg.discordMessageId || 'N/A'}`)
  console.log(`Tokens:      ~${msg.tokenEstimate}`)
  console.log(`Images:      ${msg.imageCount}`)
  if (msg.transformations.length > 0) {
    console.log(`Transforms:  ${msg.transformations.join(', ')}`)
  }
  if (msg.isTrigger) {
    console.log(`[TRIGGER MESSAGE]`)
  }
  console.log()
  console.log(`Content (${msg.contentLength} chars):`)
  console.log(`─────────────────────────────────────────────`)
  console.log(msg.contentPreview)
  console.log()
}

function cmdTokens(traceId: string): void {
  const trace = loadTrace(traceId)
  if (!trace) {
    console.error(`Trace ${traceId} not found`)
    process.exit(1)
  }
  
  const cb = trace.contextBuild
  if (!cb) {
    console.log('No context build info in this trace')
    return
  }
  
  // Group by participant
  const byParticipant = new Map<string, number>()
  for (const msg of cb.messages) {
    const current = byParticipant.get(msg.participant) || 0
    byParticipant.set(msg.participant, current + msg.tokenEstimate)
  }
  
  const total = cb.tokenEstimates.total
  
  console.log()
  console.log(`Token Breakdown for ${traceId}`)
  console.log(`────────────────────────────────────────`)
  console.log()
  console.log(`Category       Tokens      %`)
  console.log(`────────────────────────────────────────`)
  console.log(`System         ${formatTokens(cb.tokenEstimates.system).padStart(6)}   ${((cb.tokenEstimates.system / total) * 100).toFixed(1).padStart(5)}%`)
  console.log(`Images         ${formatTokens(cb.tokenEstimates.images).padStart(6)}   ${((cb.tokenEstimates.images / total) * 100).toFixed(1).padStart(5)}%`)
  console.log(`Tool Results   ${formatTokens(cb.tokenEstimates.tools).padStart(6)}   ${((cb.tokenEstimates.tools / total) * 100).toFixed(1).padStart(5)}%`)
  console.log(`Messages       ${formatTokens(cb.tokenEstimates.messages).padStart(6)}   ${((cb.tokenEstimates.messages / total) * 100).toFixed(1).padStart(5)}%`)
  console.log(`────────────────────────────────────────`)
  console.log(`Total          ${formatTokens(total).padStart(6)}   100.0%`)
  console.log()
  console.log(`By Participant:`)
  console.log(`────────────────────────────────────────`)
  
  const sorted = [...byParticipant.entries()].sort((a, b) => b[1] - a[1])
  for (const [participant, tokens] of sorted) {
    const pct = (tokens / total) * 100
    console.log(`${participant.slice(0, 14).padEnd(14)} ${formatTokens(tokens).padStart(6)}   ${pct.toFixed(1).padStart(5)}%`)
  }
  console.log()
}

function cmdFindMessage(messageId: string): void {
  const entries = loadIndex()
  const found: Array<{ traceId: string; position?: number; role: string }> = []
  
  for (const entry of entries) {
    if (entry.triggeringMessageId === messageId) {
      found.push({ traceId: entry.traceId, role: 'trigger' })
    } else if (entry.contextMessageIds.includes(messageId)) {
      // Load trace to get position
      const trace = loadTrace(entry.traceId)
      const msg = trace?.contextBuild?.messages.find(m => m.discordMessageId === messageId)
      found.push({ traceId: entry.traceId, position: msg?.position, role: 'context' })
    } else if (entry.sentMessageIds.includes(messageId)) {
      found.push({ traceId: entry.traceId, role: 'sent' })
    }
  }
  
  if (found.length === 0) {
    console.log(`Message ${messageId} not found in any traces`)
    return
  }
  
  console.log()
  console.log(`Message ${messageId} found in ${found.length} trace(s):`)
  console.log()
  
  for (const f of found.slice(0, 20)) {
    const posStr = f.position !== undefined ? ` (position ${f.position})` : ''
    console.log(`  ${f.traceId}: ${f.role}${posStr}`)
  }
  
  if (found.length > 20) {
    console.log(`  ... and ${found.length - 20} more`)
  }
  console.log()
}

function cmdDiff(traceId1: string, traceId2: string): void {
  const trace1 = loadTrace(traceId1)
  const trace2 = loadTrace(traceId2)
  
  if (!trace1) {
    console.error(`Trace ${traceId1} not found`)
    process.exit(1)
  }
  if (!trace2) {
    console.error(`Trace ${traceId2} not found`)
    process.exit(1)
  }
  
  const msgs1 = new Set(trace1.contextBuild?.messages.map(m => m.discordMessageId).filter(Boolean))
  const msgs2 = new Set(trace2.contextBuild?.messages.map(m => m.discordMessageId).filter(Boolean))
  
  const onlyIn1 = [...msgs1].filter(id => !msgs2.has(id))
  const onlyIn2 = [...msgs2].filter(id => !msgs1.has(id))
  const inBoth = [...msgs1].filter(id => msgs2.has(id))
  
  console.log()
  console.log(`Context Diff: ${traceId1} vs ${traceId2}`)
  console.log(`────────────────────────────────────────`)
  console.log()
  console.log(`Messages in common: ${inBoth.length}`)
  console.log()
  
  if (onlyIn1.length > 0) {
    console.log(`Only in ${traceId1} (${onlyIn1.length} messages):`)
    for (const id of onlyIn1.slice(0, 10)) {
      const msg = trace1.contextBuild?.messages.find(m => m.discordMessageId === id)
      console.log(`  - ${msg?.participant}: ${truncate(msg?.contentPreview || '', 50)}`)
    }
    if (onlyIn1.length > 10) console.log(`  ... and ${onlyIn1.length - 10} more`)
    console.log()
  }
  
  if (onlyIn2.length > 0) {
    console.log(`Only in ${traceId2} (${onlyIn2.length} messages):`)
    for (const id of onlyIn2.slice(0, 10)) {
      const msg = trace2.contextBuild?.messages.find(m => m.discordMessageId === id)
      console.log(`  + ${msg?.participant}: ${truncate(msg?.contentPreview || '', 50)}`)
    }
    if (onlyIn2.length > 10) console.log(`  ... and ${onlyIn2.length - 10} more`)
    console.log()
  }
  
  // Token comparison
  const t1 = trace1.contextBuild?.tokenEstimates.total || 0
  const t2 = trace2.contextBuild?.tokenEstimates.total || 0
  const diff = t2 - t1
  const sign = diff >= 0 ? '+' : ''
  
  console.log(`Token comparison:`)
  console.log(`  ${traceId1}: ${formatTokens(t1)}`)
  console.log(`  ${traceId2}: ${formatTokens(t2)} (${sign}${formatTokens(diff)})`)
  console.log()
}

function cmdRequest(traceId: string, callIndex?: string): void {
  const trace = loadTrace(traceId)
  if (!trace) {
    console.error(`Trace ${traceId} not found`)
    process.exit(1)
  }
  
  const idx = callIndex ? parseInt(callIndex, 10) : 0
  const call = trace.llmCalls[idx]
  
  if (!call) {
    console.error(`LLM call ${idx} not found in trace`)
    process.exit(1)
  }
  
  if (!call.requestBodyRef) {
    console.log('No request body reference in this call')
    console.log('Request summary:', JSON.stringify(call.request, null, 2))
    return
  }
  
  const bodyPath = join(process.cwd(), 'logs', 'llm-requests', call.requestBodyRef)
  if (!existsSync(bodyPath)) {
    console.error(`Request body file not found: ${bodyPath}`)
    process.exit(1)
  }
  
  const body = readFileSync(bodyPath, 'utf-8')
  console.log(body)
}

function cmdResponse(traceId: string, callIndex?: string): void {
  const trace = loadTrace(traceId)
  if (!trace) {
    console.error(`Trace ${traceId} not found`)
    process.exit(1)
  }
  
  const idx = callIndex ? parseInt(callIndex, 10) : 0
  const call = trace.llmCalls[idx]
  
  if (!call) {
    console.error(`LLM call ${idx} not found in trace`)
    process.exit(1)
  }
  
  if (!call.responseBodyRef) {
    console.log('No response body reference in this call')
    console.log('Response summary:', JSON.stringify(call.response, null, 2))
    return
  }
  
  const bodyPath = join(process.cwd(), 'logs', 'llm-responses', call.responseBodyRef)
  if (!existsSync(bodyPath)) {
    console.error(`Response body file not found: ${bodyPath}`)
    process.exit(1)
  }
  
  const body = readFileSync(bodyPath, 'utf-8')
  console.log(body)
}

function cmdLogs(traceId: string): void {
  const trace = loadTrace(traceId)
  if (!trace) {
    console.error(`Trace ${traceId} not found`)
    process.exit(1)
  }
  
  if (!trace.logs || trace.logs.length === 0) {
    console.log('No logs captured in this trace')
    return
  }
  
  console.log()
  console.log(`Console Logs for ${traceId} (${trace.logs.length} entries)`)
  console.log(`────────────────────────────────────────────────────────────`)
  console.log()
  
  for (const log of trace.logs) {
    const timeStr = `+${(log.offsetMs / 1000).toFixed(3)}s`.padStart(9)
    const levelStr = log.level.toUpperCase().padEnd(5)
    const dataStr = log.data ? ` ${JSON.stringify(log.data)}` : ''
    
    // Color based on level
    let prefix = ''
    if (log.level === 'error' || log.level === 'fatal') prefix = '❌ '
    else if (log.level === 'warn') prefix = '⚠️  '
    else if (log.level === 'info') prefix = 'ℹ️  '
    else prefix = '   '
    
    console.log(`${prefix}${timeStr} [${levelStr}] ${log.message}${dataStr}`)
  }
  console.log()
}

function cmdRaw(traceId: string, messageId?: string): void {
  const trace = loadTrace(traceId)
  if (!trace) {
    console.error(`Trace ${traceId} not found`)
    process.exit(1)
  }
  
  if (!trace.rawDiscordMessages || trace.rawDiscordMessages.length === 0) {
    console.log('No raw Discord messages captured in this trace')
    console.log('(This trace may have been created before raw message capture was added)')
    return
  }
  
  if (messageId) {
    // Show specific message
    const msg = trace.rawDiscordMessages.find(m => m.id === messageId)
    if (!msg) {
      console.error(`Message ${messageId} not found in raw messages`)
      process.exit(1)
    }
    
    console.log()
    console.log(`Raw Discord Message: ${messageId}`)
    console.log(`────────────────────────────────────────────────────────────`)
    console.log(`Author: ${msg.author.displayName} (@${msg.author.username}) [${msg.author.id}]`)
    console.log(`Bot: ${msg.author.bot ? 'Yes' : 'No'}`)
    console.log(`Time: ${new Date(msg.timestamp).toISOString()}`)
    if (msg.replyTo) console.log(`Reply to: ${msg.replyTo}`)
    if (msg.attachments.length > 0) {
      console.log(`Attachments: ${msg.attachments.length}`)
      for (const att of msg.attachments) {
        console.log(`  - ${att.filename} (${att.contentType || 'unknown type'}, ${att.size} bytes)`)
      }
    }
    console.log()
    console.log(`Content:`)
    console.log(`────────────────────────────────────────────────────────────`)
    console.log(msg.content)
    console.log()
  } else {
    // List all raw messages
    console.log()
    console.log(`Raw Discord Messages for ${traceId} (${trace.rawDiscordMessages.length} messages)`)
    console.log(`────────────────────────────────────────────────────────────`)
    console.log()
    
    for (const msg of trace.rawDiscordMessages) {
      const author = msg.author.displayName.slice(0, 15).padEnd(15)
      const preview = truncate(msg.content.replace(/\n/g, ' '), 50)
      const attachments = msg.attachments.length > 0 ? ` [${msg.attachments.length} att]` : ''
      const reply = msg.replyTo ? ' ↩️' : ''
      
      console.log(`${msg.id.slice(-8)}  ${author}  ${preview}${attachments}${reply}`)
    }
    console.log()
    console.log('Use `trace raw <traceId> <messageId>` to see full message content')
    console.log()
  }
}

function cmdExplain(traceId: string): void {
  const trace = loadTrace(traceId)
  if (!trace) {
    console.error(`Trace ${traceId} not found`)
    process.exit(1)
  }
  
  const cb = trace.contextBuild
  const rawCount = trace.rawDiscordMessages?.length || 0
  const logCount = trace.logs?.length || 0
  
  console.log()
  console.log(`╔══════════════════════════════════════════════════════════════════════╗`)
  console.log(`║  TRACE EXPLANATION: ${trace.traceId.padEnd(47)} ║`)
  console.log(`╚══════════════════════════════════════════════════════════════════════╝`)
  console.log()
  
  // ═══ SECTION 1: WHAT TRIGGERED THIS ═══
  console.log(`┌─ 1. WHAT TRIGGERED THIS ─────────────────────────────────────────────┐`)
  console.log(`│ Reason: ${trace.activation?.reason || 'unknown'}`)
  console.log(`│ Channel: ${trace.channelId}`)
  console.log(`│ Triggering Message: ${trace.triggeringMessageId}`)
  if (trace.activation?.triggerEvents) {
    for (const evt of trace.activation.triggerEvents) {
      console.log(`│   From: ${evt.authorName || 'unknown'} - "${truncate(evt.contentPreview || '', 40)}"`)
    }
  }
  console.log(`└──────────────────────────────────────────────────────────────────────┘`)
  console.log()
  
  // ═══ SECTION 2: WHAT DISCORD MESSAGES WERE FETCHED ═══
  console.log(`┌─ 2. RAW DISCORD MESSAGES (${rawCount} fetched) ─────────────────────────────┐`)
  if (trace.rawDiscordMessages && trace.rawDiscordMessages.length > 0) {
    const shown = trace.rawDiscordMessages.slice(-10)  // Show last 10
    if (trace.rawDiscordMessages.length > 10) {
      console.log(`│ ... ${trace.rawDiscordMessages.length - 10} earlier messages ...`)
    }
    for (const msg of shown) {
      const author = msg.author.displayName.slice(0, 12).padEnd(12)
      const preview = truncate(msg.content.replace(/\n/g, ' '), 45)
      const isTrigger = msg.id === trace.triggeringMessageId ? ' ← TRIGGER' : ''
      console.log(`│ ${author} ${preview}${isTrigger}`)
    }
  } else {
    console.log(`│ (No raw messages captured - run 'trace raw ${traceId}' after upgrade)`)
  }
  console.log(`└──────────────────────────────────────────────────────────────────────┘`)
  console.log()
  
  // ═══ SECTION 3: HOW CONTEXT WAS BUILT ═══
  console.log(`┌─ 3. CONTEXT TRANSFORMATION ──────────────────────────────────────────┐`)
  if (cb) {
    console.log(`│ Messages considered: ${cb.messagesConsidered}`)
    console.log(`│ Messages included:   ${cb.messagesIncluded}`)
    if (cb.didTruncate) {
      console.log(`│ ⚠️  TRUNCATED: ${cb.messagesRolledOff} messages rolled off (${cb.truncateReason})`)
    }
    console.log(`│ Images: ${cb.imagesIncluded}, Tool cache: ${cb.toolCacheEntries}`)
    console.log(`│ Stop sequences: ${cb.stopSequences.slice(0, 3).join(', ')}${cb.stopSequences.length > 3 ? '...' : ''}`)
    console.log(`│`)
    console.log(`│ Token estimates:`)
    console.log(`│   System:   ${formatTokens(cb.tokenEstimates.system).padStart(6)}`)
    console.log(`│   Messages: ${formatTokens(cb.tokenEstimates.messages).padStart(6)}`)
    console.log(`│   Images:   ${formatTokens(cb.tokenEstimates.images).padStart(6)}`)
    console.log(`│   Tools:    ${formatTokens(cb.tokenEstimates.tools).padStart(6)}`)
    console.log(`│   ─────────────────`)
    console.log(`│   Total:    ${formatTokens(cb.tokenEstimates.total).padStart(6)}`)
  } else {
    console.log(`│ (No context build info)`)
  }
  console.log(`└──────────────────────────────────────────────────────────────────────┘`)
  console.log()
  
  // ═══ SECTION 4: LLM CALLS ═══
  console.log(`┌─ 4. LLM CALLS (${trace.llmCalls.length}) ─────────────────────────────────────────────────┐`)
  for (const call of trace.llmCalls) {
    const tokens = `${formatTokens(call.tokenUsage.inputTokens)} in / ${formatTokens(call.tokenUsage.outputTokens)} out`
    console.log(`│ Call #${call.depth}: ${call.model}`)
    console.log(`│   Duration: ${formatDuration(call.durationMs)}, Tokens: ${tokens}`)
    console.log(`│   Stop reason: ${call.response.stopReason}`)
    if (call.response.toolUseCount > 0) {
      console.log(`│   → ${call.response.toolUseCount} tool call(s)`)
    }
    if (call.error) {
      console.log(`│   ❌ Error: ${call.error.message}`)
    }
  }
  console.log(`│`)
  console.log(`│ Use 'trace request ${traceId}' to see full LLM request`)
  console.log(`│ Use 'trace response ${traceId}' to see full LLM response`)
  console.log(`└──────────────────────────────────────────────────────────────────────┘`)
  console.log()
  
  // ═══ SECTION 5: TOOL EXECUTIONS ═══
  if (trace.toolExecutions.length > 0) {
    console.log(`┌─ 5. TOOL EXECUTIONS (${trace.toolExecutions.length}) ───────────────────────────────────────────┐`)
    for (const tool of trace.toolExecutions) {
      console.log(`│ ${tool.toolName} (${formatDuration(tool.durationMs)})`)
      console.log(`│   Input:  ${truncate(JSON.stringify(tool.input), 55)}`)
      console.log(`│   Output: ${truncate(tool.output, 55)}${tool.outputTruncated ? ' [truncated]' : ''}`)
      if (tool.error) {
        console.log(`│   ❌ Error: ${tool.error}`)
      }
    }
    console.log(`└──────────────────────────────────────────────────────────────────────┘`)
    console.log()
  }
  
  // ═══ SECTION 6: OUTCOME ═══
  console.log(`┌─ 6. OUTCOME ─────────────────────────────────────────────────────────┐`)
  if (trace.outcome) {
    if (trace.outcome.success) {
      console.log(`│ ✅ SUCCESS`)
      console.log(`│ Response (${trace.outcome.responseLength} chars):`)
      const lines = trace.outcome.responseText.split('\n').slice(0, 5)
      for (const line of lines) {
        console.log(`│   ${truncate(line, 60)}`)
      }
      if (trace.outcome.responseText.split('\n').length > 5) {
        console.log(`│   ...`)
      }
      console.log(`│ Sent ${trace.outcome.messagesSent} message(s): ${trace.outcome.sentMessageIds.join(', ')}`)
    } else {
      console.log(`│ ❌ FAILED`)
      console.log(`│ Phase: ${trace.outcome.error?.phase}`)
      console.log(`│ Error: ${trace.outcome.error?.message}`)
    }
  } else {
    console.log(`│ (No outcome recorded)`)
  }
  console.log(`│`)
  console.log(`│ Duration: ${formatDuration(trace.durationMs || 0)}`)
  console.log(`└──────────────────────────────────────────────────────────────────────┘`)
  console.log()
  
  // ═══ SECTION 7: CONSOLE LOGS ═══
  console.log(`┌─ 7. CONSOLE LOGS (${logCount} entries) ───────────────────────────────────────┐`)
  if (trace.logs && trace.logs.length > 0) {
    // Show key logs (errors, warnings, and a sample of info)
    const errors = trace.logs.filter(l => l.level === 'error' || l.level === 'fatal')
    const warnings = trace.logs.filter(l => l.level === 'warn')
    const infos = trace.logs.filter(l => l.level === 'info')
    
    if (errors.length > 0) {
      console.log(`│ ❌ ERRORS (${errors.length}):`)
      for (const log of errors.slice(0, 5)) {
        console.log(`│   +${(log.offsetMs / 1000).toFixed(2)}s: ${truncate(log.message, 50)}`)
      }
    }
    if (warnings.length > 0) {
      console.log(`│ ⚠️  WARNINGS (${warnings.length}):`)
      for (const log of warnings.slice(0, 3)) {
        console.log(`│   +${(log.offsetMs / 1000).toFixed(2)}s: ${truncate(log.message, 50)}`)
      }
    }
    console.log(`│ ℹ️  INFO entries: ${infos.length}`)
    console.log(`│`)
    console.log(`│ Use 'trace logs ${traceId}' to see all logs`)
  } else {
    console.log(`│ (No logs captured - upgrade tracing to capture logs)`)
  }
  console.log(`└──────────────────────────────────────────────────────────────────────┘`)
  console.log()
}

function printUsage(): void {
  console.log(`
Trace CLI - Navigate and inspect activation traces

MAIN COMMANDS:
  trace explain <traceId>                  Full debugging view (start here!)
  trace find-message <discordMessageId>    Find traces containing a message

DETAIL COMMANDS:
  trace list [--channel <id>] [--failed] [--limit N]   List recent traces
  trace outline <traceId>                              Show trace summary
  trace raw <traceId> [messageId]                      Show raw Discord messages
  trace logs <traceId>                                 Show console logs from activation
  trace message <traceId> <position>                   Show context message at position
  trace tokens <traceId>                               Show token breakdown
  trace diff <traceId1> <traceId2>                     Compare two traces

LLM INSPECTION:
  trace request <traceId> [callIndex]                  Show full LLM request JSON
  trace response <traceId> [callIndex]                 Show full LLM response JSON
  trace show <traceId>                                 Show raw trace JSON

WORKFLOW:
  1. Get Discord message ID from the weird message
  2. trace find-message <messageId>  → get trace ID
  3. trace explain <traceId>         → see full picture
  4. trace raw <traceId>             → see what Discord sent
  5. trace request <traceId>         → see exact LLM input
  6. trace logs <traceId>            → see decision logs

Examples:
  trace find-message 1234567890123456789
  trace explain abc123
  trace raw abc123 1234567890123456789
  trace logs abc123
`)
}

// ============================================================================
// Main
// ============================================================================

const args = process.argv.slice(2)
const command = args[0]

switch (command) {
  case 'list':
    cmdList(args.slice(1))
    break
  case 'show':
    if (!args[1]) { console.error('Missing traceId'); process.exit(1) }
    cmdShow(args[1])
    break
  case 'outline':
    if (!args[1]) { console.error('Missing traceId'); process.exit(1) }
    cmdOutline(args[1])
    break
  case 'explain':
    if (!args[1]) { console.error('Missing traceId'); process.exit(1) }
    cmdExplain(args[1])
    break
  case 'message':
    if (!args[1] || !args[2]) { console.error('Missing traceId or position'); process.exit(1) }
    cmdMessage(args[1], args[2])
    break
  case 'raw':
    if (!args[1]) { console.error('Missing traceId'); process.exit(1) }
    cmdRaw(args[1], args[2])
    break
  case 'logs':
    if (!args[1]) { console.error('Missing traceId'); process.exit(1) }
    cmdLogs(args[1])
    break
  case 'tokens':
    if (!args[1]) { console.error('Missing traceId'); process.exit(1) }
    cmdTokens(args[1])
    break
  case 'find-message':
    if (!args[1]) { console.error('Missing messageId'); process.exit(1) }
    cmdFindMessage(args[1])
    break
  case 'diff':
    if (!args[1] || !args[2]) { console.error('Missing traceId(s)'); process.exit(1) }
    cmdDiff(args[1], args[2])
    break
  case 'request':
    if (!args[1]) { console.error('Missing traceId'); process.exit(1) }
    cmdRequest(args[1], args[2])
    break
  case 'response':
    if (!args[1]) { console.error('Missing traceId'); process.exit(1) }
    cmdResponse(args[1], args[2])
    break
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    printUsage()
    break
  default:
    console.error(`Unknown command: ${command}`)
    printUsage()
    process.exit(1)
}

