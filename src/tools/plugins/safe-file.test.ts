import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAllowedFile } from './safe-file.js'

let dir: string
let allowed: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'safe-file-test-'))
  allowed = join(dir, 'documents')
  await mkdir(allowed)
  await mkdir(join(dir, 'documents-private'))
  await writeFile(join(allowed, 'chat.txt'), 'Uploaded document')
  await writeFile(join(dir, 'documents-private', '.env'), 'SYNTHETIC_FIXTURE_ONLY')
  vi.stubEnv('READ_FILE_ALLOWED_DIRS', allowed)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

describe('local file allowlist', () => {
  it('denies all access unless the host configured directories', async () => {
    vi.stubEnv('READ_FILE_ALLOWED_DIRS', '')
    await expect(readAllowedFile(join(allowed, 'chat.txt'), 100)).rejects.toThrow('disabled')
  })
  it('reads a file inside the allowed directory', async () => {
    expect((await readAllowedFile(join(allowed, 'chat.txt'), 100)).toString()).toBe(
      'Uploaded document'
    )
  })
  it('blocks traversal, sibling prefix matches and symlink escapes', async () => {
    const outside = join(dir, 'documents-private', '.env')
    await symlink(outside, join(allowed, 'linked.txt'))
    await symlink(join(dir, 'documents-private'), join(allowed, 'linked-dir'))
    for (const path of [
      outside,
      join(allowed, '../documents-private/.env'),
      join(allowed, 'linked.txt'),
      join(allowed, 'linked-dir/.env')
    ]) {
      await expect(readAllowedFile(path, 100)).rejects.toThrow('outside')
    }
  })
  it('rejects directories and oversized documents', async () => {
    await mkdir(join(allowed, 'subdirectory'))
    await expect(readAllowedFile(join(allowed, 'subdirectory'), 100)).rejects.toThrow('regular')
    await expect(readAllowedFile(join(allowed, 'chat.txt'), 2)).rejects.toThrow('size limit')
  })
  it('rejects root-wide and relative grants', async () => {
    for (const root of ['/', '.']) {
      vi.stubEnv('READ_FILE_ALLOWED_DIRS', root)
      await expect(readAllowedFile(join(allowed, 'chat.txt'), 100)).rejects.toThrow(
        'explicit absolute'
      )
    }
  })
})
