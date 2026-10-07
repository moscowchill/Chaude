import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work)
    this.tail = next.catch(() => {})
    return next
  }

  async drain(): Promise<void> {
    await this.tail
  }
}

// Activations and administrative memory edits share one writer.
export const memoryQueue = new SerialQueue()
const writes = new SerialQueue()

export async function atomicJson(file: string, data: unknown, backup = false): Promise<void> {
  // Serialize before awaiting, so later caller mutations cannot change this write.
  const json = JSON.stringify(data, null, 2)
  await writes.run(async () => {
    await fs.mkdir(dirname(file), { recursive: true })
    const temp = `${file}.${randomUUID()}.tmp`
    const previous = `${temp}.previous`
    try {
      const handle = await fs.open(temp, 'wx', 0o600)
      try {
        await handle.writeFile(json)
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (backup) {
        try {
          await fs.copyFile(file, previous)
          await fs.chmod(previous, 0o600)
          await fs.rename(previous, `${file}.previous`)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      await fs.rename(temp, file)
      const directory = await fs.open(dirname(file), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } finally {
      await fs.rm(temp, { force: true })
      await fs.rm(previous, { force: true })
    }
  })
}
