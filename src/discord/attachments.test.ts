import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiscordConnector } from './connector.js'
import { EventQueue } from '../agent/event-queue.js'
import type { Attachment } from 'discord.js'
import type { CachedDocument } from '../types.js'
import { logger } from '../utils/logger.js'

vi.mock('../utils/logger.js', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger, createLogger: () => logger }
})

let dir: string
let connector: DiscordConnector
beforeEach(() => {
  vi.stubEnv('READ_FILE_ALLOWED_DIRS', '')
  dir = mkdtempSync(join(tmpdir(), 'chat-attachments-'))
  connector = new DiscordConnector(new EventQueue(), {
    token: 'test',
    cacheDir: dir,
    maxBackoffMs: 10
  })
})
afterEach(async () => {
  await connector.close()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('chat documents with local file access disabled', () => {
  it('reads text uploaded to Discord', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Chat text fixture')))
    const attachment = {
      url: 'https://cdn.discordapp.com/attachments/test.txt',
      name: 'test.txt',
      size: 17,
      contentType: 'text/plain'
    } as Attachment
    const read = Reflect.get(connector, 'fetchTextAttachment') as (
      a: Attachment,
      id: string
    ) => Promise<CachedDocument | null>
    const doc = await read.call(connector, attachment, 'message-1')
    expect(doc?.text).toContain('Chat text fixture')
  })

  it('extracts text from an uploaded PDF using the real PDF parser', async () => {
    const pdf = readFileSync(new URL('./fixtures/chat-document.pdf', import.meta.url))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(pdf)))
    const attachment = {
      url: 'https://cdn.discordapp.com/attachments/test.pdf',
      name: 'test.pdf',
      size: pdf.length,
      contentType: 'application/pdf'
    } as Attachment
    const read = Reflect.get(connector, 'fetchPdfAttachment') as (
      a: Attachment,
      id: string
    ) => Promise<CachedDocument | null>
    const doc = await read.call(connector, attachment, 'message-2')
    expect(doc, JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toBeNull()
    expect(doc?.text).toContain('Chat PDF fixture')
    expect(doc?.text).toContain('[PDF: 1 page]')
  })
})
