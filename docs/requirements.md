Core:
A chat bot has its main loop. Its loop can contain LLM requests, although some events dont produce an LLM call. LLM calls are synchronous. 

Discord connection is managed asynchronously outside of the agent loop. Relevant discord events are passed to the agent thread. All availble discord events are processed as a batch (a queue is polled until the next event is not a discord event) and the whole batch is processed in one iteration. 

Agents perform LLM requests at most once per iteration, unless tool use is detected. Some iterations dont result in an LLM requests (for example when a bot was not mentioned or replied to).

The LLM calls are performed by custom-developed middleware that abstracts the specifics of LLM providers. The main providers supported are: Anthropic API, Anthropic API via Bedrock, OpenAI-compatible API with possibility of custom fields and Google API.

The most common use case is via Anthropic and Bedrock APIs. For either there are two modes, chat and prefill. Prefill is used more commonly. Chat mode is straighfforward. 

### Error handling

LLM API calls implement a configurable number of retries per call. Discord API calls use exponential backoff with a configurable cap for retry attempts.

### Prefill
Prefill mode works as follows:

There is a system message: `The system is in CLI simulation mode.`, followed by a user message `<cmd>cat untitled.txt</cmd>`. Most other messages (from all participants, including the agent themselves) are in a one or more assistant-role messages in the colon format:
```
User1: Hello

Claude: Hi, how are you?

User1: Very good.

Claude:
```

Note that the last content of prefill is the name of the bot followed by the colon message. This causes the model to complete the generation as a message from that bot.

The messages are split whenever there is a need to include additional content blocks or other tags. The most common causes to split assistant messages are image and cache_control blocks.

The traditional tool use pattern does not work in prefill mode. It is instead substituted with an ephemeral message from the system describing the tools, and by parsing the tool call from the completion. Ephemeral messages are inserted temporarily before the LLM call and are not persisted or reconstructed - they exist only for that specific completion.

All recent configurable N participant names followed by ":" must be included as stop sequences when using Prefill mode.

If a bot is activated and its previous message is from the same bot, newlines are not added and the 'username:' suffix is not added in order to enable natural continuation of the previous message.

### Dot messages

Messages that start with a period are not visible to bots by default. All other messages, including bots own messages are visible.

### Discord context

There is no local persistence of context (other than tool use) and the context is not cached in memory, this makes handling edits and deletions easier. Context is persisted via normal Discord interactions. When either a tag or a reply are detected in the discord connector, configurable number of previous messages (400 by default) are fetched via API and included in the message that is passed to the agent loop.

Context depth can be defined as either a number of messages or a number of characters. When both limits are specified, the lower bound takes priority (whichever limit is reached first).

Messages are split if they exceed 1800 characters to respect the Discord message limit. When building context from discord, messages from bot authors that are consecutive are considered to be logically part of the same message and are concatenated with a space as separator.

Images from Discord messages are passed to the LLM as vision input. The `max_images` and `include_images` configuration parameters control this behavior. Only the most recent images up to the limit are included in context.

Message edits and deletions require no special handling because Discord history is fetched anew for every bot activation.

Typing indicator is sent when an LLM completion begins and is stopped when the LLM completion completes.

Messages with the dotted_face emoji (🙃) are treated as if they start with a period and are not visible to bots by default.

### Tool use and Discord

Both tool use and response to tool use can be sent to Discord as a single message starting with a period as two Webhook requests with a custom name (unlike normal messages, which are sent via Bot API):
```
botname>[toolname]: [tool call with json stripped and unrolled]
botname<[toolname]: [tool call result with json stripped and unrolled]
```
The visibility of tool outputs in Discord can be configured per bot. Tool calls (along with results) are persisted locally in jsonl files. One file is used per bot per channel per hour. Files are closed and new ones created at hour boundaries. Old files are kept indefinitely. These files are used to seed the in-memory cache on startup but are not consulted afterwards during operation. 

Tool use and prompt caching markers are both locally cached and persisted in the agent loop. Tool use older than oldest messages in context is discarded from the in-memory cache. The resulting context is reconstructed in the agent loop prior to processing.

### m commands
Users can specify commands to bots that start from letter 'm' followed by a space. When a bot reacts to an m command, it attempts to delete the user message with the m command. If deletion fails (e.g., due to permission issues), the failure is logged to console. The most common m command is "m continue". This causes the bot to activate a completion without being explicitly tagged or being replied to.

### Configuration via Discord and otherwise

All messages that start with a period can contain relevant bot instructions. The most common are:
```
.history [targets]
---
first: http://discordurl
last: http://discordurl
```
History messages must be from a user with an authorized role in order to be recognized.

```
.config [targets]
---
yaml_goes_here
```
Config messages must be pinned in order to be recognized. Pinned messages are scanned for configuration on every Discord history pull, so no special startup scanning is required.

If bot's inner name is found in the space-separated set of targets, this command applies to this bot. The full configuration is determined in the discord connector and is passed along with the message to the agent loop.

The configuration is determined by combining the following yamls sequentially, with each level overriding previous:
1. shared YAML config
2. guild-specific YAML config
3. bot-specific YAML config
4. bot-guild-specific YAML config
5. channel bot configs in chronological order, from older to newest


### History command

History command concatenates effective context. `First` argument is optional. `Last` argument is mandatory. Each history command is replaced with the specified interval of messages. If `first` message is not found by backwards traversal from the last message until the depth of context is reached, the `first` argument is ignored.

Threads are considered to implicitly contain a history message pointing to the point where they were branched from (unless the first message in a thread is a .history message).

### Rolling context

The context is rolling in steps to maximize prompt caching performance. Old messages are not removed until a configurable number of new messages has been accumulated, then the context is truncated. This allows setting the prompt caching marker to a specific message id and moving it forward only when the context is truncated from the rear.

The `.history` command takes precedence over rolling context. Rolling context operates on the message portion of the resulting context after it is assembled via history commands. If there is a prefix to the context, it is not part of the rolling process.

When the prompt caching marker is moved, it is placed at the head (most recent) message of the context, or N messages (like 5) below it. Cache invalidation can occur due to config changes mid-conversation or message edits, which is acceptable. As long as the marker position is remembered and context construction is deterministic, the system maintains efficiency.

Each channel or thread is its own independent context (unless the memory faculty is used).

### Bot architecture and multi-bot interactions

Each bot runs in a separate process and can operate across multiple guilds, each having multiple channels and threads. Contexts are independent for the same bot across different channels/threads.

Bots can mention (ping) other bots in their responses. Tool use messages from other bots are not visible to bots (because tool messages start with a period). Ping loops are prevented by limiting the chain of consecutive bot pings to a configurable value.

### MCP

The agent loop includes an MCP client. If a tool use is detected in the output, the LLM interaction is looped until tools are no longer detected in completion or a maximum depth of iteration is reached (100 calls by default).

### Glossary

**Inner name**: Each bot has a Discord nickname and name provided through the Discord API, but also has a name configured in its YAML config. The inner name is how the bot's name is rendered in the LLM context (e.g., in the "Claude:" prefix for prefill mode).

**Effective context**: The complete context assembled for an LLM request, including all messages from Discord history, tool use from JSONL files, and any ephemeral messages, after applying all transformations like history commands and rolling context truncation.

**Ephemeral message**: A message that is inserted temporarily into context for a specific LLM call but is not persisted to Discord or JSONL files and is not reconstructed in future context builds.

**Dot messages**: Messages starting with a period (.) that are used for bot commands and configuration. These messages are not visible to bots by default.

**Memory faculty**: A feature to be implemented later that will allow contexts to be shared or linked across different channels/threads for the same bot.