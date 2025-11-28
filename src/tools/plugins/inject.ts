/**
 * Context Injection Plugin
 * 
 * Allows injecting arbitrary text at specific depths in context via bot config.
 * No tools - purely config-driven.
 * 
 * Config example (in bot config or pinned message):
 * ```yaml
 * plugin_config:
 *   inject:
 *     injections:
 *       - id: persona
 *         content: "Remember: you love cats."
 *         depth: 5
 *         anchor: latest  # 5 messages from the end
 *       - id: rules  
 *         content: "Important context goes here."
 *         depth: 0
 *         anchor: earliest  # At the very beginning
 * ```
 */

import { ToolPlugin, ContextInjection } from '../../types.js'
import { PluginStateContext } from './types.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('plugin:inject')

interface InjectionConfig {
  id: string
  content: string
  depth: number
  anchor?: 'earliest' | 'latest'  // Default: 'latest'
  priority?: number  // Higher = inserted earlier at same depth
}

interface InjectPluginConfig {
  injections?: InjectionConfig[]
}

const plugin: ToolPlugin = {
  name: 'inject',
  description: 'Inject arbitrary text at specific depths in context (config-driven, no tools)',
  tools: [],  // No tools - purely config-driven
  
  /**
   * Get context injections from plugin config
   */
  getContextInjections: async (context: PluginStateContext): Promise<ContextInjection[]> => {
    const config = context.pluginConfig as InjectPluginConfig | undefined
    
    if (!config?.injections?.length) {
      return []
    }
    
    const results: ContextInjection[] = []
    
    for (const injection of config.injections) {
      if (!injection.id || !injection.content) {
        logger.warn({ injection }, 'Skipping injection with missing id or content')
        continue
      }
      
      const anchor = injection.anchor || 'latest'
      
      // For 'latest' anchor, depth is distance from end (targetDepth)
      // For 'earliest' anchor, we use negative depth to signal "from start"
      // The context builder will handle the actual positioning
      
      let targetDepth: number
      if (anchor === 'earliest') {
        // Negative depth means "from the start"
        // depth 0 from earliest = position 0 (very start)
        // depth 5 from earliest = position 5 (after first 5 messages)
        targetDepth = -(injection.depth + 1)  // Negative signals "from start"
      } else {
        // Positive depth means "from the end" (normal behavior)
        targetDepth = injection.depth
      }
      
      results.push({
        id: `inject:${injection.id}`,
        content: injection.content,
        targetDepth,
        priority: injection.priority ?? 0,
      })
      
      logger.debug({
        id: injection.id,
        depth: injection.depth,
        anchor,
        targetDepth,
        contentLength: injection.content.length
      }, 'Added injection from config')
    }
    
    logger.info({ count: results.length }, 'Returning config-driven injections')
    return results
  },
}

export default plugin


