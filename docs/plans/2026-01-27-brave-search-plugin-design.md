# Brave Search Plugin Design

## Overview

Add web search and fetch capabilities to Chaude via a new `brave-search` plugin that provides two tools:
- `web_search` - Search the web using Brave Search API
- `web_fetch` - Fetch and extract readable content from URLs

## Configuration

**Environment Variable:**
```bash
BRAVE_API_KEY=your-brave-api-key
```

**Bot Config:**
```yaml
tool_plugins: ['notes', 'brave-search']
```

## Tools

### `web_search`

Search the web and return results.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| query | string | Yes | Search query |
| count | number | No | Results to return (1-10, default: 5) |
| freshness | string | No | Filter: "pd" (day), "pw" (week), "pm" (month), "py" (year) |

**Returns:**
```json
{
  "query": "claude code mcp",
  "count": 5,
  "results": [
    {
      "title": "MCP - Model Context Protocol",
      "url": "https://modelcontextprotocol.io/",
      "description": "The Model Context Protocol is an open standard...",
      "age": "2 days ago"
    }
  ],
  "cached": false,
  "tookMs": 342
}
```

### `web_fetch`

Fetch a URL and extract readable content.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| url | string | Yes | URL to fetch |
| maxChars | number | No | Max content length (default: 30000) |

**Returns:**
```json
{
  "url": "https://example.com/article",
  "title": "Article Title",
  "text": "Extracted markdown content...",
  "truncated": false,
  "cached": false,
  "tookMs": 891
}
```

## Implementation Details

### Caching

- **Search cache:** 15 minute TTL, max 100 entries
- **Fetch cache:** 30 minute TTL, max 50 entries
- Cache key: normalized query + params
- LRU eviction when full

### Content Extraction

For HTML pages:
1. Try `@mozilla/readability` for article extraction
2. Fallback to basic HTML → markdown conversion
3. Strip scripts, styles, navigation
4. Truncate to maxChars

For JSON: Pretty-print and return as-is.

### Error Handling

- Missing API key: Clear error message with setup instructions
- HTTP errors: Include status code and truncated error body
- Timeout: 30 second default
- Invalid URL: Validate before fetching

## File Structure

```
src/tools/plugins/
├── brave-search.ts      # Main plugin (tools + cache)
├── brave-search-utils.ts # HTML extraction utilities
└── index.ts             # Add export
```

## Dependencies

New npm packages:
- `@mozilla/readability` - Article extraction
- `linkedom` - DOM parsing (no browser needed)
