# MCP Configuration Guide

Chapter3 supports multiple MCP (Model Context Protocol) servers, allowing the bot to use tools from different sources simultaneously.

## Configuration

Add `mcpServers` to your bot config (`config/bots/{botname}.yaml`):

```yaml
name: Claude  # Name used in LLM context
# ... other config ...

toolsEnabled: true
toolOutputVisible: false  # Set true to see tool calls in Discord
maxToolDepth: 100

# Multiple MCP servers
mcpServers:
  - name: filesystem
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/olena/Documents"]
  
  - name: everything
    command: npx
    args: ["-y", "@modelcontextprotocol/server-everything"]
  
  - name: github
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_TOKEN: "ghp_your_token_here"
```

**Benefits:**
- ✅ Configure multiple servers simultaneously
- ✅ Per-bot configuration
- ✅ Can be overridden per-guild or per-channel
- ✅ Environment variables for sensitive data (tokens, keys)

## Available MCP Servers

### Official Servers

1. **@modelcontextprotocol/server-everything**
   - Demo server with multiple example tools
   - Good for testing
   ```yaml
   - name: everything
     command: npx
     args: ["-y", "@modelcontextprotocol/server-everything"]
   ```

2. **@modelcontextprotocol/server-filesystem**
   - File operations (read, write, list, search)
   - Requires directory argument
   ```yaml
   - name: filesystem
     command: npx
     args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/workspace"]
   ```

3. **@modelcontextprotocol/server-github**
   - GitHub API operations (issues, PRs, repos)
   - Requires GITHUB_TOKEN
   ```yaml
   - name: github
     command: npx
     args: ["-y", "@modelcontextprotocol/server-github"]
     env:
       GITHUB_TOKEN: "ghp_your_token_here"
   ```

4. **@modelcontextprotocol/server-postgres**
   - PostgreSQL database queries
   ```yaml
   - name: postgres
     command: npx
     args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://connection_string"]
   ```

5. **@modelcontextprotocol/server-slack**
   - Slack API operations
   ```yaml
   - name: slack
     command: npx
     args: ["-y", "@modelcontextprotocol/server-slack"]
     env:
       SLACK_BOT_TOKEN: "xoxb-your-token"
   ```

### Custom Servers

You can also use custom MCP servers:

```yaml
mcpServers:
  - name: custom-server
    command: python
    args: ["./my-mcp-server.py"]
    env:
      API_KEY: "your-key"
```

## How It Works

### Server Initialization

1. **On First Activation**: When the bot is activated for the first time, it reads the config
2. **Concurrent Initialization**: All servers are initialized in parallel
3. **Tool Discovery**: Tools from all servers are collected
4. **Server Mapping**: Each tool remembers which server it came from

### Tool Execution

1. **Tool Call**: Bot decides to call a tool (e.g., `read_file`)
2. **Server Lookup**: System finds which server provides that tool
3. **Routing**: Call is routed to the correct MCP server
4. **Result**: Result returned to bot for continuation

### Example With Multiple Servers

```yaml
mcpServers:
  - name: files
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/olena/workspace"]
  
  - name: github
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_TOKEN: "ghp_..."
```

**Available Tools:**
- From `files` server: `read_file`, `write_file`, `list_directory`, `search_files`
- From `github` server: `create_issue`, `list_repos`, `get_pull_request`, etc.

**Bot can use all tools naturally:**
```
User: Read the README.md file and create a GitHub issue about it

Bot: [uses read_file from files server]
     [uses create_issue from github server]
     Done! Created issue #42
```

## Configuration Per Guild/Channel

MCP servers can be overridden per-guild or per-channel:

**Guild Override** (`config/guilds/{guild_id}.yaml`):
```yaml
mcpServers:
  - name: everything
    command: npx
    args: ["-y", "@modelcontextprotocol/server-everything"]
```

**Channel Override** (pinned message in Discord):
```
.config claude
---
toolsEnabled: false
```

## Troubleshooting

### Tools Not Showing Up

1. Check logs for "MCP server initialized" messages
2. Verify server is installed: `npx -y @modelcontextprotocol/server-everything --help`
3. Check `toolsEnabled: true` in config
4. Look for errors in logs

### Tool Execution Fails

1. Check server logs (stderr is captured)
2. Verify environment variables are set correctly
3. Check file permissions (for filesystem server)
4. Test server independently: `npx -y @modelcontextprotocol/server-everything`

### Server Won't Start

1. Check command and args are correct
2. Verify npx or command is in PATH
3. Check for port conflicts
4. Look for initialization errors in logs

## Testing MCP Tools

### 1. Enable Tool Output Visibility

```yaml
toolOutputVisible: true  # See tool calls in Discord
```

### 2. Mention Bot With Tool Request

```
@YourBot Can you list the files in the current directory?
```

### 3. Check Logs

```bash
tail -f bot.log | grep -i "tool\|mcp"
```

### 4. Check Tool Cache

```bash
ls -la tools/claude/*/
cat tools/claude/*/2024-11-14-18.jsonl
```

## Example: Full Configuration

```yaml
name: Claude  # Name used in LLM context

mode: prefill
continuationModel: claude-sonnet-4-5-20250929
temperature: 1.0
maxTokens: 4096

recencyWindowMessages: 400
rollingThreshold: 50
recentParticipantCount: 10

includeImages: true
maxImages: 5

toolsEnabled: true
toolOutputVisible: true  # Show tools in Discord for testing
maxToolDepth: 100

# Multiple MCP servers
mcpServers:
  # Filesystem access
  - name: fs
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/olena/workspace"]
  
  # Everything demo server
  - name: demo
    command: npx
    args: ["-y", "@modelcontextprotocol/server-everything"]
  
  # GitHub integration
  - name: github  
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_TOKEN: "ghp_your_token"
      GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_your_token"
```

## Environment Variables in MCP Config

For sensitive data, use environment variables:

```yaml
mcpServers:
  - name: github
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_TOKEN: "${GITHUB_TOKEN}"  # Will be interpolated from process.env
```

Then set when running:
```bash
export GITHUB_TOKEN=ghp_your_token
npm run dev
```

## Quick Start: Testing with Everything Server

1. **Add to your bot config:**
```yaml
toolsEnabled: true
toolOutputVisible: true
mcpServers:
  - name: everything
    command: npx
    args: ["-y", "@modelcontextprotocol/server-everything"]
```

2. **Restart bot**

3. **Test:**
```
@YourBot What tools do you have available?
```

The bot will list all discovered tools from the MCP server!

## Advanced: Channel-Specific Tools

Different channels can have different tool sets:

**Pin in #dev channel:**
```
.config claude
---
mcpServers:
  - name: filesystem
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/olena/code"]
```

**Pin in #github channel:**
```
.config claude
---
mcpServers:
  - name: github
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_TOKEN: "ghp_..."
```

Now the bot has different tools in different channels!

