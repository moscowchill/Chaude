import { describe, expect, it, vi } from 'vitest'
import { ToolSystem } from './system.js'
import type { ActivationResult, ToolPlugin } from './plugins/types.js'

describe('background memory lifecycle', () => {
  it('awaits hooks before returning and continues to the next plugin after a failure', async () => {
    const tools = new ToolSystem('/synthetic-tools')
    let release!: () => void
    const first = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const broken = vi.fn().mockRejectedValue(new Error('failed'))
    const last = vi.fn().mockResolvedValue(undefined)
    const internals = tools as unknown as { loadedPluginObjects: Map<string, ToolPlugin> }
    internals.loadedPluginObjects = new Map([
      ['first', { name: 'first', tools: [], onPostActivation: first }],
      ['broken', { name: 'broken', tools: [], onPostActivation: broken }],
      ['last', { name: 'last', tools: [], onPostActivation: last }]
    ])
    tools.setPluginContext({ channelId: 'original-channel' })
    tools.setPluginContextFactory({
      createStateContext: (_id: string, context: unknown) => context
    })
    let done = false
    const pending = tools
      .firePostActivationHooks({ success: true } as ActivationResult)
      .then(() => {
        done = true
      })
    await Promise.resolve()
    expect(done).toBe(false)
    expect(last).not.toHaveBeenCalled()
    release()
    await pending
    expect(last).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'original-channel' }),
      expect.anything()
    )
    expect(done).toBe(true)
  })
})
