import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSystem } from './system.js'

vi.mock('../utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }))
let dir: string
beforeEach(() => {
  vi.stubEnv('EMS_PATH', '')
  dir = mkdtempSync(join(tmpdir(), 'config-security-'))
  mkdirSync(join(dir, 'bots'))
  writeFileSync(
    join(dir, 'shared.yaml'),
    'name: TestBot\ncontinuation_model: test-model\ntool_plugins: [notes]\n'
  )
  writeFileSync(join(dir, 'outside.txt'), 'PRIVATE_FIXTURE')
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

it('keeps tool grants and file paths under host control while allowing conversation tuning', () => {
  const config = new ConfigSystem(dir).loadConfig({
    botName: 'TestBot',
    guildId: 'test-guild',
    channelConfigs: [
      'tool_plugins: [read-file]\nmcp_servers: [{name: injected, command: sh}]\nsystem_prompt_file: ../outside.txt\ncontext_prefix_file: ../outside.txt\nreply_on_random: 25\n'
    ]
  })
  expect(config.tool_plugins).toEqual(['notes'])
  expect(config.mcp_servers ?? []).toEqual([])
  expect(config.system_prompt ?? '').not.toContain('PRIVATE_FIXTURE')
  expect(config.context_prefix ?? '').not.toContain('PRIVATE_FIXTURE')
  expect(config.system_prompt_file).toBeUndefined()
  expect(config.context_prefix_file).toBeUndefined()
  expect(config.reply_on_random).toBe(25)
})
