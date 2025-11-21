# Chapter3 REST API

The bot includes an optional REST API for programmatic access to Discord conversation history and user information.

## Quick Reference

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check |
| `/api/messages/export` | POST | Yes | Export conversation history (follows `.history` commands) |
| `/api/users/:userId` | GET | Yes | Get user info (username, display name, roles, avatar) |
| `/api/users/:userId/avatar` | GET | Yes | Get user avatar CDN URL |

## Setup

1. Generate a secure API token:
```bash
openssl rand -hex 32 > api_token
```

2. Set environment variable:
```bash
export API_BEARER_TOKEN=$(cat api_token)
export API_PORT=3000  # Optional, defaults to 3000
```

3. Start the bot:
```bash
npm run dev
```

The API server will start alongside the bot and log: `"API server started" { port: 3000 }`

## Endpoints

### Health Check
```http
GET /health
```

No authentication required.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2025-11-14T23:00:00.000Z"
}
```

**Example:**
```bash
curl http://localhost:3000/health
```

---

### Export Messages
```http
POST /api/messages/export
```

Export Discord conversation history with full metadata. Automatically processes `.history` commands found in channels (uses unified traversal logic with the bot).

**Authentication:** Bearer token required in `Authorization` header

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

**Parameters:**
- `last` (required): Discord message URL - end point of range
- `first` (optional): Discord message URL - start point of range  
- `recencyWindow` (optional): Limits to apply
  - `messages`: Maximum number of messages (default: 50)
  - `characters`: Maximum total characters
  - If omitted entirely, defaults to 50 messages

**Response:**
```json
{
  "messages": [
    {
      "id": "1234567890",
      "author": {
        "id": "9876543210",
        "username": "alice",
        "displayName": "Alice",
        "bot": false
      },
      "content": "Hello world!",
      "timestamp": "2025-11-14T23:00:00.000Z",
      "reactions": [
        {"emoji": "👍", "count": 3},
        {"emoji": "❤️", "count": 1}
      ],
      "attachments": [
        {
          "id": "...",
          "url": "https://cdn.discord.com/...",
          "filename": "image.png",
          "contentType": "image/png",
          "size": 123456
        }
      ],
      "referencedMessageId": "1234567889"
    }
  ],
  "metadata": {
    "channelId": "1234567890",
    "guildId": "9876543210",
    "firstMessageId": "1234567880",
    "lastMessageId": "1234567890",
    "totalCount": 100,
    "truncated": false
  }
}
```

---

### Get User Info
```http
GET /api/users/:userId?guildId=GUILD_ID
```

Get information about a Discord user, optionally with server-specific details.

**Authentication:** Bearer token required

**Parameters:**
- `userId` (path, required): Discord user ID
- `guildId` (query, optional): Guild ID for server-specific display name and roles

**Response:**
```json
{
  "id": "1030846477418909696",
  "username": "q_m_o",
  "displayName": "Egr. Catalyst",
  "discriminator": "0",
  "bot": false,
  "avatarUrl": "https://cdn.discordapp.com/avatars/.../....webp?size=128",
  "roles": ["mod", "alpha tester", "bot orchestrator"]
}
```

**Notes:**
- Without `guildId`: Returns username as displayName, no roles field
- With `guildId`: Returns server-specific nickname and role list
- `roles` array excludes @everyone

**Example:**
```bash
# Global user info
curl "http://localhost:3000/api/users/1030846477418909696" \
  -H "Authorization: Bearer your-token-here"

# Server-specific info
curl "http://localhost:3000/api/users/1030846477418909696?guildId=1052321771216457748" \
  -H "Authorization: Bearer your-token-here"
```

---

### Get User Avatar
```http
GET /api/users/:userId/avatar?size=SIZE
```

Get CDN URL for a user's avatar image.

**Authentication:** Bearer token required

**Parameters:**
- `userId` (path, required): Discord user ID
- `size` (query, optional): Avatar size in pixels (128, 256, 512, 1024)
  - Default: 128

**Response:**
```json
{
  "avatarUrl": "https://cdn.discordapp.com/avatars/USER_ID/HASH.png?size=256"
}
```

**Example:**
```bash
curl "http://localhost:3000/api/users/1030846477418909696/avatar?size=256" \
  -H "Authorization: Bearer your-token-here"
```

---

## Example Usage

### Python
```python
import requests

# Export messages
response = requests.post(
    'http://localhost:3000/api/messages/export',
    headers={'Authorization': 'Bearer your-token-here'},
    json={
        'last': 'https://discord.com/channels/123/456/789',
        'recencyWindow': {'messages': 400}
    }
)

data = response.json()
for msg in data['messages']:
    print(f"{msg['author']['displayName']}: {msg['content']}")

# Get user info
user_id = data['messages'][0]['author']['id']
user_info = requests.get(
    f'http://localhost:3000/api/users/{user_id}?guildId=123',
    headers={'Authorization': 'Bearer your-token-here'}
).json()

print(f"User: {user_info['displayName']}")
print(f"Roles: {', '.join(user_info['roles'])}")
```

### curl
```bash
# Export messages
curl -X POST http://localhost:3000/api/messages/export \
  -H "Authorization: Bearer $(cat api_token)" \
  -H "Content-Type: application/json" \
  -d '{
    "last": "https://discord.com/channels/123/456/789",
    "first": "https://discord.com/channels/123/456/700",
    "recencyWindow": {"messages": 400}
  }'

# Get user info
curl "http://localhost:3000/api/users/1030846477418909696?guildId=123" \
  -H "Authorization: Bearer $(cat api_token)"

# Get avatar
curl "http://localhost:3000/api/users/1030846477418909696/avatar?size=512" \
  -H "Authorization: Bearer $(cat api_token)"
```

## Use Cases

1. **Research Commons Integration** - Export Discord conversations for web archive with full user metadata
2. **Prompt Generation** - Similar to old `/get_prompt` command
3. **Data Analysis** - Extract conversation data with reactions, attachments, and user info
4. **Backup/Archive** - Programmatic conversation backups with complete metadata
5. **User Directory** - Build user profiles with server-specific names, roles, and avatars
6. **Frontend Display** - Get avatar URLs and display names for UI rendering

## API Features Summary

### Message Export
- ✅ **Unified `.history` support** - Same traversal logic as bot
- ✅ **Reactions included** - Emoji and count for each reaction
- ✅ **Attachments** - Full metadata (URL, filename, size, type)
- ✅ **Reply tracking** - referencedMessageId for threaded conversations
- ✅ **Cross-channel/server** - Works with any Discord URL
- ✅ **Recency limits** - Message count or character limits

### User Information
- ✅ **Global user info** - Username, discriminator, bot flag
- ✅ **Server-specific** - Display name and roles per guild
- ✅ **Avatar URLs** - CDN links with configurable size
- ✅ **Space for mapping** - Future author aliasing support

## Security

- ✅ Bearer token authentication (all endpoints except `/health`)
- ✅ Bot must have access to requested channels
- ✅ Respects Discord permissions (bot's view of channel)
- ⚠️ Keep `api_token` file secure
- ⚠️ Consider rate limiting for production use

## Future: Author Mapping

Space reserved for mapping Discord users to participant aliases:

```json
{
  "author": {
    "id": "123",
    "username": "alice",
    "displayName": "Alice",
    "mappedParticipant": "Researcher_A"  // Future feature
  }
}
```

Configuration will be added to allow anonymization/aliasing for research/export purposes.

