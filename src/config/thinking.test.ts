import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSystem } from './system.js'

vi.mock('../utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }))
let dir: string
beforeEach(() => {
  vi.stubEnv('EMS_PATH', '')
  dir = mkdtempSync(join(tmpdir(), 'config-thinking-'))
  mkdirSync(join(dir, 'bots'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

function load(yaml: string) {
  writeFileSync(join(dir, 'shared.yaml'), `name: TestBot\ncontinuation_model: claude-haiku-5-5\n${yaml}`)
  return new ConfigSystem(dir).loadConfig({ botName: 'TestBot', guildId: 'test-guild', channelConfigs: [] })
}

it('passes thinking and effort through from YAML, and leaves them unset by default', () => {
  expect(load('thinking: adaptive\neffort: medium\n')).toMatchObject({ thinking: 'adaptive', effort: 'medium' })
  const plain = load('')
  expect(plain.thinking).toBeUndefined()
  expect(plain.effort).toBeUndefined()
})

it('rejects unknown thinking modes and effort levels', () => {
  expect(() => load('thinking: enabled\n')).toThrow('thinking must be adaptive or disabled')
  expect(() => load('effort: extreme\n')).toThrow('effort must be')
})

it('rejects thinking turned off at the effort levels where the API refuses it', () => {
  expect(() => load('thinking: disabled\neffort: max\n')).toThrow('effort high or below')
  expect(() => load('thinking: disabled\neffort: xhigh\n')).toThrow('effort high or below')
  expect(load('thinking: disabled\neffort: high\n')).toMatchObject({ thinking: 'disabled', effort: 'high' })
})
