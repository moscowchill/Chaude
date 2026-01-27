# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Development with hot reload (loads .env automatically)
npm run build        # TypeScript compile to dist/
npm start            # Production (requires npm run build first)
npm run lint         # ESLint
npm run format       # Prettier
npm test             # Vitest
npm test -- --run src/llm/membrane/adapter.test.ts  # Single test file
```

## Architecture

Chaude is a Discord bot framework with multi-LLM support. The flow:

```
Discord Event → EventQueue → AgentLoop → ContextBuilder → LLMMiddleware → Provider → Discord Response
```

### Key Components

**AgentLoop** (`src/agent/loop.ts`) - Main orchestrator. Polls EventQueue, decides activation (mention, reply, random chance, m-command), coordinates all other components, handles tool execution loops.

**DiscordConnector** (`src/discord/connector.ts`) - Discord domain expert. WebSocket events, message fetching, `.history` command traversal, pinned config scanning, image caching, typing indicators, message sending with auto-split at 1800 chars.

**ContextBuilder** (`src/context/builder.ts`) - Transforms Discord messages to LLM format. Merges consecutive bot messages, filters dot-prefixed messages, applies rolling context truncation, places cache markers for prompt caching.

**LLMMiddleware** (`src/llm/middleware.ts`) - Routes to providers, transforms between prefill/chat modes. Prefill mode sends entire conversation as text (for base models), chat mode uses turn-based API format.

**ConfigSystem** (`src/config/system.ts`) - Hierarchical YAML config with 30s TTL cache. Priority: shared.yaml → guild config → bot config → pinned channel config.

**ToolSystem** (`src/tools/system.ts`) - MCP client wrapper + plugin system. Tool calls persisted to JSONL in `tools/{botId}/{channelId}/`.

### Data Flow

1. Discord events pushed to `EventQueue`
2. `AgentLoop` polls batches, calls `shouldActivate()` (checks mention, reply, m-command, random chance)
3. `DiscordConnector.fetchContext()` gets messages, pinned configs, images
4. `ConfigSystem.loadConfig()` merges YAML hierarchy
5. `ContextBuilder.buildContext()` transforms to `ParticipantMessage[]` format
6. `LLMMiddleware` transforms to provider-specific format and calls API
7. Response parsed, tools executed if needed (loop back to step 6)
8. Final text sent via `DiscordConnector.sendMessage()`

### Core Types (`src/types.ts`)

- `ParticipantMessage` - Normalized format: `{participant: string, content: ContentBlock[], messageId?}`
- `LLMRequest` - Full request with messages, system_prompt, tools, stop_sequences
- `BotConfig` - All bot configuration options (mode, model, temperature, context limits, etc.)

### Plugins (`src/tools/plugins/`)

Plugins provide tools and context injections:
- `notes` - Save/read notes with context injection
- `inject` - Config-driven text injection at specific context depths
- `upload`, `share-image` - File/image handling

State scopes: `global`, `channel`, `epic` (event-sourced with rollback)

## Configuration

Bot configs in `config/bots/{bot-name}.yaml`. Key settings:
- `mode`: `prefill` (base models) or `chat` (API models like Claude)
- `continuation_model`: Model name to use
- `recency_window_messages`/`recency_window_characters`: Context limits
- `rolling_threshold`: Messages before context rolls
- `tool_plugins`: Array of plugin names to load
- `reply_on_random`: N for 1/N random reply chance (0 to disable)

Vendor configs in `config/shared.yaml` declare which models each vendor provides. API keys come from env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.).

## Debugging

Traces saved to `logs/traces/{botName}/`. Use trace CLI:
```bash
./scripts/trace list --limit 10
./scripts/trace explain <trace-id>
./scripts/trace request <trace-id>   # Full LLM request
./scripts/trace response <trace-id>  # Full LLM response
```

Web viewer: `./scripts/trace serve` → http://localhost:3847
