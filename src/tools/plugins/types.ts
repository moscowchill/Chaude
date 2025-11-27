/**
 * Tool Plugin Types
 */

export interface ToolPlugin {
  name: string
  description: string
  tools: PluginTool[]
}

export interface PluginTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
  }
  handler: (input: any, context: PluginContext) => Promise<any>
}

export interface PluginContext {
  botId: string
  channelId: string
  config: any  // Current bot config
  sendMessage: (content: string) => Promise<string[]>  // Send a message, returns message IDs
  pinMessage: (messageId: string) => Promise<void>  // Pin a message
}

