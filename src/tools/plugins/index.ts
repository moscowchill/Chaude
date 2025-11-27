/**
 * Plugin Registry
 * 
 * All available plugins are registered here.
 */

import { ToolPlugin } from './types.js'
import configPlugin from './config.js'

// Register all available plugins
export const availablePlugins: Record<string, ToolPlugin> = {
  'config': configPlugin,
}

export * from './types.js'

