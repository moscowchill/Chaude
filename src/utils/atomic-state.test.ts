import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicJson, SerialQueue } from './atomic-state.js'
import { ActivationCooldown } from './cooldown.js'

describe('durable memory writes', () => {
  it('writes complete snapshots, preserves one prior version and uses private file permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chaude-atomic-'))
    try {
      const file = join(dir, 'notes.json')
      await Promise.all(Array.from({ length: 8 }, (_, value) => atomicJson(file, { value }, true)))
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ value: 7 })
      expect(JSON.parse(await readFile(`${file}.previous`, 'utf8'))).toEqual({ value: 6 })
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      expect((await readdir(dir)).sort()).toEqual(['notes.json', 'notes.json.previous'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('serializes async work and continues after a failure', async () => {
    const queue = new SerialQueue()
    const events: string[] = []
    const first = queue.run(async () => {
      await Promise.resolve()
      events.push('first')
      throw new Error('failed')
    })
    const second = queue.run(async () => {
      events.push('second')
    })
    await expect(first).rejects.toThrow('failed')
    await second
    await queue.drain()
    expect(events).toEqual(['first', 'second'])
  })
  it('paces a user across channels and resets when the cooldown has elapsed', () => {
    const cooldown = new ActivationCooldown(10_000, 5000)
    expect(cooldown.reserve('a', 'user', 100)).toBe(0)
    expect(cooldown.reserve('b', 'user', 1100)).toBe(9000)
    expect(cooldown.reserve('a', 'other', 2100)).toBe(3000)
    expect(cooldown.reserve('a', 'user', 30_000)).toBe(0)
  })
})
