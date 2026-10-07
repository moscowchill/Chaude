# Chaude - Discord Bot Framework

A sophisticated Discord chat bot framework with multi-LLM support, MCP tool integration, and advanced context management.

## Features

- **Multi-Participant Context**: Honest representation of Discord conversations
- **Multiple LLM Providers**: Anthropic, AWS Bedrock, OpenAI-compatible, Google Gemini
- **Prefill & Chat Modes**: Full support for both conversation modes
- **MCP Tool Integration**: Native Model Context Protocol support
- **Smart Context Compaction**: Auto-summarizes old messages to preserve context while reducing tokens
- **Rolling Context**: Efficient prompt caching with rolling message windows
- **Rate-Limit Handling**: Respects API rate limits with proper backoff and Discord error feedback
- **Hierarchical Configuration**: YAML-based config with guild/channel overrides
- **Image Support**: Automatic image caching and vision input
- **Advanced Features**: History commands, m commands, dot messages

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy the example environment file and fill in your secrets:

```bash
cp .env.example .env
```

Edit `.env` with your values:

```bash
# Required
DISCORD_TOKEN=your-discord-bot-token
ANTHROPIC_API_KEY=sk-ant-api03-...

# Optional - other providers
OPENAI_API_KEY=sk-...
OPENROUTER_API_KEY=sk-or-...

# Optional - enable REST API
API_BEARER_TOKEN=your-secure-token  # Generate with: openssl rand -hex 32
API_PORT=3000
```

**Note:** The bot name is automatically determined from the Discord bot's username. Config is loaded from `config/bots/{discord-username}.yaml`.

### 3. Create Bot Configuration

Create `config/bots/your-bot-name.yaml` (see `config/bots/Chaude.yaml` for a full example):

```yaml
name: MyBot  # Name used in LLM context

mode: chat
continuation_model: claude-haiku-5-5
thinking: adaptive  # Optional: Anthropic API thinking (adaptive | disabled)
effort: medium      # Optional: low | medium | high | xhigh | max
max_tokens: 8192    # Thinking shares this budget with the reply

recency_window_messages: 400
recency_window_characters: 100000
rolling_threshold: 50

include_images: true
max_images: 5

tools_enabled: true
tool_plugins: ['notes']

reply_on_random: 50  # 1 in 50 chance to randomly reply
```

### 4. Configure Vendor

Create `config/shared.yaml` to declare which models each vendor provides. API keys are read from environment variables (set in `.env`).

**Anthropic** (uses `ANTHROPIC_API_KEY`):
```yaml
vendors:
  anthropic:
    provides:
      - "claude-haiku-5-*"
      - "claude-sonnet-5-*"
      - "claude-opus-5-*"
      - "claude-haiku-4-5-*"
      - "claude-3-5-sonnet-*"
      - "claude-sonnet-4-*"
      - "claude-opus-4-*"
```

**OpenAI** (uses `OPENAI_API_KEY`):
```yaml
vendors:
  openai:
    provides:
      - "gpt-4o*"
      - "gpt-4-turbo*"
```

**OpenRouter** (uses `OPENROUTER_API_KEY`):
```yaml
vendors:
  openrouter:
    provides:
      - "anthropic/claude-3-opus"
      - "openai/gpt-4-turbo"
```

**Notes on OpenAI provider:**
- Only supports `mode: chat` (not prefill - OpenAI doesn't allow partial assistant messages)
- Images not yet supported (different format from Anthropic)

### 5. Run

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

## Documentation

- [Architecture](./docs/architecture.md) - Detailed architecture documentation
- [Requirements](./docs/requirements.md) - Full functional requirements
- [API](./docs/API.md) - REST API documentation
- [MCP Configuration](./docs/MCP_CONFIGURATION.md) - MCP tool setup
- [Plugins](./docs/plugins.md) - Plugin system documentation
- [Deployment](./docs/deployment.md) - Production deployment guide

### Key Components

- **Agent Loop**: Main orchestrator
- **Discord Connector**: Handles all Discord API interactions
- **Context Builder**: Transforms Discord → participant format
- **LLM Middleware**: Transforms participant → provider format
- **Tool System**: MCP integration and JSONL persistence
- **Config System**: Hierarchical YAML configuration

## Configuration

### Bot Configuration

See `config/bots/Chaude.yaml` for a complete example. Key options:

```yaml
# Identity
name: BotName  # Name used in LLM context (prefill labels, stop sequences)

# Model
mode: chat  # or 'prefill' for base models
continuation_model: claude-haiku-5-5
temperature: 0.7  # Only for models that take it: Claude Haiku 5.5 and other current models accept only their default sampling, and Chaude leaves it out for them
thinking: adaptive  # Anthropic API thinking: adaptive | disabled (unset: Claude Haiku 5.5 runs with thinking off)
effort: medium  # Anthropic output_config.effort: low | medium | high | xhigh | max
max_tokens: 8192

# Context
recency_window_messages: 400  # Max messages in context
recency_window_characters: 100000  # Max characters (whichever limit hit first)
rolling_threshold: 50  # Messages before context rolls

# Images
include_images: true
max_images: 5

# Tools
tools_enabled: true
tool_plugins: ['notes']  # Available: notes, brave-search, upload, share-image, inject, compaction
max_tool_depth: 100

# Behavior
reply_on_random: 50  # 1/N chance to randomly reply (0 to disable)
```

### Example: Open Source Project Observer

A bot that monitors GitHub webhooks and dev discussions, taking notes on important decisions:

```yaml
name: Observer

system_prompt: |
  You are an open source project observer. Your role is to monitor this server for:

  - Webhook updates from GitHub, GitLab, and other dev tools (commits, PRs, issues, releases)
  - Developers discussing code, architecture, and technical decisions
  - Important announcements, breaking changes, and deprecations

  When you notice something significant, use your notes tools to record it:
  - save_note: Record important decisions, breaking changes, new features, architecture discussions
  - list_notes / read_note: Reference past context when relevant to current discussion

  What to note:
  - Major version releases and breaking changes
  - Architecture decisions and their rationale
  - API changes and migrations
  - Security issues and fixes

  Be concise in your notes. Use clear titles like "claude-code v1.2 - new MCP support".

  You can also search the web when needed:
  - web_search: Search for documentation, release notes, or current information
  - web_fetch: Read the content of a specific URL

mode: chat
continuation_model: claude-haiku-5-5
max_tokens: 8192
tool_plugins: ['notes', 'brave-search']
reply_on_random: 50
```

### Context Compaction

The compaction plugin automatically summarizes older messages to preserve context while reducing token usage. This prevents rate limits and keeps important information accessible.

**How it works:**
1. After each activation, checks if context is approaching the rolling threshold
2. Summarizes the oldest ~25 messages using a fast model (Haiku 4.5)
3. Extracts topic keywords for future intelligent retrieval
4. Injects summaries at the start of context on subsequent activations

**Enable compaction:**
```yaml
tool_plugins: ['notes', 'compaction']

plugin_config:
  compaction:
    enabled: true
    threshold_percent: 80           # Trigger at 80% of rolling_threshold
    summary_model: claude-haiku-5-5  # Fast/cheap model for summaries
    max_summaries: 15               # Keep at most 15 summaries
    messages_per_summary: 25        # Summarize in blocks of 25 messages
```

**Token savings:**
- Before: 100 old messages = ~8,000 tokens
- After: 1 summary = ~500 tokens
- **~90% reduction** on older context

**Intelligent selection:** When you have many notes and summaries, the plugin asks the LLM which ones are relevant to the current topic:
```yaml
plugin_config:
  notes:
    inject_into_context: false  # Let compaction handle injection
  compaction:
    enable_selection: true
    selection_model: claude-haiku-5-5
    selection_threshold: 5      # Only select if >5 sources
    max_injections: 5           # Inject at most 5 relevant sources
```

**Best practice:** Use a stronger model (Sonnet 5.5) for main responses and a fast model (Haiku 5.5) for background work:
```yaml
continuation_model: claude-sonnet-5-5  # Main responses
plugin_config:
  compaction:
    summary_model: claude-haiku-5-5   # Summarization
    selection_model: claude-haiku-5-5 # Topic selection
```

### Discord Commands

**History Command** (requires authorized role):
```
.history botname
---
first: https://discord.com/channels/.../message_id
last: https://discord.com/channels/.../message_id
```

**Config Command** (must be pinned):
```
.config botname
---
temperature: 0.7
maxTokens: 2000
```

**M Commands**:
- `m continue` - Activate bot without mention

## Debugging & Tracing

The bot includes a comprehensive tracing system that captures every activation, including Discord context, LLM requests/responses, tool executions, and console logs.

### Trace Web Viewer

Start the local web viewer to browse and search traces:

```bash
./trace serve
# Opens at http://localhost:3847
```

Features:
- **Search by Discord URL**: Paste any Discord message URL to find related traces
- **Full LLM request/response viewer**: See exactly what was sent to the API
- **Context transformation details**: Understand how Discord messages became LLM context
- **Console log filtering**: Filter logs by level (debug, info, warn, error)
- **Token usage & cost info**: Track API usage per activation

### Trace CLI

```bash
# List recent traces
./trace list --limit 10

# Show trace summary
./trace explain <trace-id>

# View full LLM request
./trace request <trace-id>

# View full LLM response  
./trace response <trace-id>

# View console logs
./trace logs <trace-id>
```

### Trace Files

Traces are stored in `logs/traces/` as JSON files with an index at `logs/traces/index.jsonl` for fast lookups.

## Development

```bash
# Install dependencies
npm install

# Development mode
npm run dev

# Build
npm run build

# Lint
npm run lint

# Format
npm run format

# Test
npm test
```

## Updating Dependencies

### Membrane (LLM Abstraction Layer)

Chaude uses [membrane](https://github.com/antra-tess/membrane) as its LLM abstraction layer. Membrane is installed as a git dependency and won't auto-update with regular `npm install`.

**To update membrane to the latest version:**

```bash
npm update membrane
```

This will fetch the latest commit from the `main` branch and update your `package-lock.json`.

> **Note:** After updating, you should commit the updated `package-lock.json` to keep your deployment in sync. A future release of membrane will be published to npm for easier version management.

**Check current vs latest version:**

```bash
# See what you have installed
npm ls membrane

# See latest on GitHub
git ls-remote https://github.com/antra-tess/membrane.git refs/heads/main | cut -c1-7
```

## Requirements

- Node.js 20+
- TypeScript 5.3+
- Discord bot token (`DISCORD_TOKEN` in `.env`)
- LLM API keys (`ANTHROPIC_API_KEY`, etc. in `.env`)

## Automatic welcomes

Set `WELCOME_GUILD_ID` and `WELCOME_CHANNEL_ID` in `.env`, then enable Server Members Intent in the Discord developer portal. The bot welcomes human members in that channel after any membership screening completes. It requires View Channel and Send Messages permissions.

`WELCOME_MESSAGE` optionally overrides the greeting; `{user}` becomes the new member's mention. Welcomes use a fixed message without an LLM call. Duplicate events are suppressed using persisted state in the cache directory and a Discord message nonce. A later rejoin can receive another welcome. Keep the cache directory across restarts.

## Tool access

- Uploaded text and PDF attachments are processed directly from Discord. This works with the `read-file` plugin disabled.
- `read_file` denies access by default. Operators may set `READ_FILE_ALLOWED_DIRS` to explicit absolute directories containing curated, non-secret documents, separated by the platform path separator. Paths outside these directories, including symlink escapes, are rejected.
- `web_fetch` accepts public HTTP(S) pages on their default ports. It checks DNS results and each redirect, pins connections to checked addresses, and limits downloads to 2 MiB. Private, loopback, link-local, and reserved destinations are blocked.
- Pinned channel configuration cannot grant plugins, launch MCP servers, or select local prompt files. Set those capabilities in the host configuration.
- Bot messages suppress everyone and role notifications. Welcomes can notify only the joining member.

### Optional Linux filesystem sandbox

After building, `bash scripts/sandbox.sh` starts the bot using bubblewrap. The launcher exposes code, dependencies, configuration, and `.env` as read-only inputs; only `cache`, `logs`, and `tools` persist writes. It uses the default application paths and loads bot settings from `.env`. Other home directories and host processes are hidden.

Install bubblewrap through your operating system. `NODE_BINARY` can select a Node executable, and `SANDBOX_APPARMOR_PROFILE` can select an administrator-created profile on hosts that restrict user namespaces. The launcher fails if the sandbox cannot be established. Network access remains available for Discord, model providers, and public web pages; the web-fetch tool enforces its own destination policy.

## REST API

If enabled with `API_BEARER_TOKEN`, the bot exposes a REST API for accessing Discord conversation history.

### Endpoints

#### `GET /health`
Health check (no auth required)

```bash
curl http://localhost:3000/health
```

#### `POST /api/messages/export`
Export Discord conversation history

**Authentication:** Bearer token required

**Request Body:**
```json
{
  "last": "https://discord.com/channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID",
  "first": "https://discord.com/channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID",
  "recencyWindow": {
    "messages": 400,
    "characters": 100000
  }
}
```

**Example:**
```bash
curl -X POST http://localhost:3000/api/messages/export \
  -H "Authorization: Bearer your-token-here" \
  -H "Content-Type: application/json" \
  -d '{"last": "https://discord.com/channels/123/456/789"}'
```

## Acknowledgements

Chaude is developed to be compatible and interoperable with the [chapter2](https://github.com/joysatisficer/chapter2). Many critical concepts, including the use of Discord as the single source of truth, supporting real-time configuration via pinned Discord messages and other, have been pioneered in chapter2 by [Janus](https://x.com/repligate) and [ampdot](https://x.com/amplifiedamp)/[joysatisficer](https://x.com/joysatisficer).


## License

MIT

## Curated knowledge and spending controls

The optional community guide in `config/knowledge/myqrlwallet.json` covers
MyQRLWallet, QRL/post-quantum cryptography and ecdsa.fail. Topics have sources,
review dates and search aliases. The operator reviews and edits this file;
chat users and model tools cannot rewrite it. It is loaded at startup. Relevant
topics are selected locally, without an embedding service or a model call.
For changing facts, the bot is instructed to check current primary sources.

Configure through the host environment:

```dotenv
KNOWLEDGE_FILE=./config/knowledge/myqrlwallet.json
DAILY_BUDGET_USD=2
IGNORE_WEBHOOK_MESSAGES=true
CONTROL_GUILD_IDS=<guild-id>
USER_COOLDOWN_MS=10000
CHANNEL_COOLDOWN_MS=5000
```

`IGNORE_WEBHOOK_MESSAGES` removes webhook posts from conversational context,
attachment processing and subsequent memory work. No Git-history import runs.
Cool-downs pace accepted activations without discarding their trigger.
Activations and administrative note edits run serially, and post-response
memory work finishes before its trace is saved. Slow background work can delay
the next response. State writes use atomic replacement and retain one previous
snapshot in a `.previous` file for operator recovery.

### Discord commands

Commands register only in `CONTROL_GUILD_IDS` (comma-separated server IDs),
without replacing unrelated commands. Replies are visible only to the requester.

- `/status`: default model, accounted/reserved daily spending, knowledge coverage
  and the last model failure since startup.
- `/knowledge [topic]`: inspect the guide, review dates and primary sources.
- `/memory [id] [page]`: inspect saved conversation notes in the current channel.
- `/forget id:<note-id>`: remove an active channel note. Requires current
  **Manage Messages** permission. Curated knowledge is maintained separately.

These memory commands address channel-scoped notes. Removal clears the
consolidation restore copy; historical traces and operator recovery snapshots
retain their own retention policies. The command edits active memory only.

### Budget accounting

The daily limit covers every managed model generation, including note
consolidation, document summaries, selection and tool continuations. Days reset
at 00:00 UTC. Reservations are saved in `cache/spending.json` before a paid call
and survive restarts. Keep that directory persistent and use one bot process per
ledger. The ledger starts accounting when enabled; it is independent of any
other software using the API account.

The metered route currently supports direct Anthropic models with verified
pricing and token counting. The counter reserves input with padding, the
highest input/cache price, and maximum output. Successful calls settle against
reported usage; cache writes use the conservative one-hour rate. Ambiguous
failures and missing usage keep their reservation. Explicit rejected requests
release it. These conservative totals can exceed the provider's eventual bill.
They exclude taxes and external services such as Brave Search.

Unsupported models and membrane/shadow routes fail closed while budgeting is
enabled. Add verified model rates through host-only `LLM_PRICING_JSON`, an object
mapping exact model IDs to `input`, `output`, `cacheWrite` and `cacheRead` prices
in USD per million tokens. Check [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)
before changing models. Auth, billing and validation failures are surfaced
immediately; transient failures have bounded retries and respect Retry-After.

### History controls

`.history` requires current **Manage Messages** permission or an ID in the
host's `authorized_roles` list. Role names are no longer accepted. Bot/webhook
control messages are ignored. Same-channel history is supported; cross-channel
imports require a source visible with history access to everyone in the same
guild, without member/role read denies. Private threads and cross-guild imports
are rejected. Traversal is bounded and detects repeated locations.

### Model upgrade checks

`npm run eval:knowledge` previews eight questions and review criteria without
calling an API. For a deliberate comparison, stop the bot using that ledger and
run `npm run eval:knowledge -- --run --model <model-id>` with the configured
credentials, guide and daily limit in the environment. Each result records the
answer, latency, token usage and budget totals. Review source use, uncertainty,
crypto distinctions and resistance to injected instructions before changing the
live model. The runner sends no Discord messages.
