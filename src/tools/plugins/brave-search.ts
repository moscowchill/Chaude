/**
 * Brave Search Plugin
 *
 * Provides web_search and web_fetch tools using the Brave Search API.
 *
 * Enable via:
 *   tool_plugins: ['brave-search']
 *
 * Requires BRAVE_API_KEY environment variable.
 */

import { ToolPlugin, PluginTool, PluginContext } from './types.js'
import { createLogger } from '../../utils/logger.js'
import { extractReadableContent, htmlToMarkdown, truncateText } from './brave-search-utils.js'

const logger = createLogger({ plugin: 'brave-search' })

// =============================================================================
// Constants
// =============================================================================

const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

const DEFAULT_SEARCH_COUNT = 5
const DEFAULT_FETCH_MAX_CHARS = 30_000
const DEFAULT_TIMEOUT_MS = 30_000

const SEARCH_CACHE_TTL_MS = 15 * 60 * 1000  // 15 minutes
const FETCH_CACHE_TTL_MS = 30 * 60 * 1000   // 30 minutes
const SEARCH_CACHE_MAX = 100
const FETCH_CACHE_MAX = 50

// =============================================================================
// Cache
// =============================================================================

interface CacheEntry<T> {
  value: T
  expiresAt: number
  insertedAt: number
}

const searchCache = new Map<string, CacheEntry<SearchResult>>()
const fetchCache = new Map<string, CacheEntry<FetchResult>>()

function normalizeCacheKey(value: string): string {
  return value.trim().toLowerCase()
}

function readCache<T>(cache: Map<string, CacheEntry<T>>, key: string): CacheEntry<T> | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    cache.delete(key)
    return null
  }
  return entry
}

function writeCache<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number,
  maxSize: number
): void {
  // Evict oldest if at capacity
  if (cache.size >= maxSize) {
    let oldestKey: string | null = null
    let oldestTime = Infinity
    for (const [k, v] of cache) {
      if (v.insertedAt < oldestTime) {
        oldestTime = v.insertedAt
        oldestKey = k
      }
    }
    if (oldestKey) cache.delete(oldestKey)
  }

  const now = Date.now()
  cache.set(key, {
    value,
    expiresAt: now + ttlMs,
    insertedAt: now,
  })
}

// =============================================================================
// Types
// =============================================================================

interface BraveSearchResult {
  title?: string
  url?: string
  description?: string
  age?: string
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResult[]
  }
}

interface SearchResult {
  query: string
  count: number
  results: Array<{
    title: string
    url: string
    description: string
    age?: string
  }>
  tookMs: number
  cached?: boolean
}

interface FetchResult {
  url: string
  finalUrl?: string
  title?: string
  text: string
  truncated: boolean
  tookMs: number
  cached?: boolean
}

// =============================================================================
// API Key Resolution
// =============================================================================

function getBraveApiKey(): string | null {
  const key = process.env.BRAVE_API_KEY?.trim()
  return key || null
}

// =============================================================================
// Web Search Implementation
// =============================================================================

interface SearchParams {
  query: string
  count?: number
  freshness?: string
}

async function runWebSearch(params: SearchParams): Promise<SearchResult> {
  const apiKey = getBraveApiKey()
  if (!apiKey) {
    throw new Error(
      'BRAVE_API_KEY not configured. Set it in your .env file.\n' +
      'Get an API key at: https://brave.com/search/api/'
    )
  }

  const query = params.query.trim()
  if (!query) {
    throw new Error('Search query cannot be empty')
  }

  const count = Math.max(1, Math.min(10, params.count ?? DEFAULT_SEARCH_COUNT))
  const freshness = params.freshness?.trim() || ''

  // Check cache
  const cacheKey = normalizeCacheKey(`search:${query}:${count}:${freshness}`)
  const cached = readCache(searchCache, cacheKey)
  if (cached) {
    logger.debug({ query, count }, 'Returning cached search results')
    return { ...cached.value, cached: true }
  }

  // Build URL
  const url = new URL(BRAVE_SEARCH_ENDPOINT)
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(count))
  if (freshness) {
    url.searchParams.set('freshness', freshness)
  }

  const start = Date.now()

  // Make request
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': apiKey,
      },
      signal: controller.signal,
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText)
      throw new Error(`Brave Search API error (${res.status}): ${detail}`)
    }

    const data = await res.json() as BraveSearchResponse
    const rawResults = Array.isArray(data.web?.results) ? data.web.results : []

    const results = rawResults.map(entry => ({
      title: entry.title ?? '',
      url: entry.url ?? '',
      description: entry.description ?? '',
      age: entry.age,
    }))

    const result: SearchResult = {
      query,
      count: results.length,
      results,
      tookMs: Date.now() - start,
    }

    // Cache result
    writeCache(searchCache, cacheKey, result, SEARCH_CACHE_TTL_MS, SEARCH_CACHE_MAX)
    logger.info({ query, count: results.length, tookMs: result.tookMs }, 'Web search completed')

    return result
  } finally {
    clearTimeout(timeout)
  }
}

// =============================================================================
// Web Fetch Implementation
// =============================================================================

interface FetchParams {
  url: string
  maxChars?: number
}

async function runWebFetch(params: FetchParams): Promise<FetchResult> {
  const urlString = params.url.trim()
  if (!urlString) {
    throw new Error('URL cannot be empty')
  }

  // Validate URL
  let parsedUrl: URL
  try {
    parsedUrl = new URL(urlString)
  } catch {
    throw new Error('Invalid URL format')
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('URL must use http or https protocol')
  }

  const maxChars = Math.max(100, params.maxChars ?? DEFAULT_FETCH_MAX_CHARS)

  // Check cache
  const cacheKey = normalizeCacheKey(`fetch:${urlString}:${maxChars}`)
  const cached = readCache(fetchCache, cacheKey)
  if (cached) {
    logger.debug({ url: urlString }, 'Returning cached fetch result')
    return { ...cached.value, cached: true }
  }

  const start = Date.now()

  // Make request
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

  try {
    const res = await fetch(urlString, {
      method: 'GET',
      headers: {
        'Accept': '*/*',
        'User-Agent': 'Mozilla/5.0 (compatible; Chaude/1.0; +https://github.com/moscowchill/Chaude)',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
      redirect: 'follow',
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText)
      const truncatedDetail = detail.slice(0, 500)
      throw new Error(`Fetch failed (${res.status}): ${truncatedDetail}`)
    }

    const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
    const body = await res.text()
    const finalUrl = res.url !== urlString ? res.url : undefined

    let title: string | undefined
    let text: string

    if (contentType.includes('text/html')) {
      // Extract readable content
      const extracted = await extractReadableContent({
        html: body,
        url: finalUrl ?? urlString,
        extractMode: 'markdown',
      })

      if (extracted) {
        text = extracted.text
        title = extracted.title
      } else {
        // Fallback to basic conversion
        const converted = htmlToMarkdown(body)
        text = converted.text
        title = converted.title
      }
    } else if (contentType.includes('application/json')) {
      // Pretty-print JSON
      try {
        const parsed = JSON.parse(body)
        text = JSON.stringify(parsed, null, 2)
      } catch {
        text = body
      }
    } else if (contentType.includes('text/')) {
      // Plain text
      text = body
    } else {
      throw new Error(`Unsupported content type: ${contentType}`)
    }

    // Truncate if needed
    const truncated = truncateText(text, maxChars)

    const result: FetchResult = {
      url: urlString,
      finalUrl,
      title,
      text: truncated.text,
      truncated: truncated.truncated,
      tookMs: Date.now() - start,
    }

    // Cache result
    writeCache(fetchCache, cacheKey, result, FETCH_CACHE_TTL_MS, FETCH_CACHE_MAX)
    logger.info({
      url: urlString,
      title,
      length: truncated.text.length,
      truncated: truncated.truncated,
      tookMs: result.tookMs,
    }, 'Web fetch completed')

    return result
  } finally {
    clearTimeout(timeout)
  }
}

// =============================================================================
// Tool Definitions
// =============================================================================

const webSearchTool: PluginTool<SearchParams, string> = {
  name: 'web_search',
  description:
    'Search the web using Brave Search. Returns titles, URLs, and descriptions. ' +
    'Use this to find information, documentation, or current events.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
      count: {
        type: 'number',
        description: 'Number of results to return (1-10, default: 5)',
      },
      freshness: {
        type: 'string',
        description:
          'Filter by recency: "pd" (past day), "pw" (past week), "pm" (past month), "py" (past year)',
      },
    },
    required: ['query'],
  },
  handler: async (input: SearchParams, _context: PluginContext): Promise<string> => {
    const result = await runWebSearch(input)

    // Format results for LLM
    const lines: string[] = [
      `Search: "${result.query}" (${result.count} results${result.cached ? ', cached' : ''})`,
      '',
    ]

    for (let i = 0; i < result.results.length; i++) {
      const r = result.results[i]!
      lines.push(`${i + 1}. ${r.title}`)
      lines.push(`   ${r.url}`)
      if (r.description) {
        lines.push(`   ${r.description}`)
      }
      if (r.age) {
        lines.push(`   Published: ${r.age}`)
      }
      lines.push('')
    }

    return lines.join('\n')
  },
}

const webFetchTool: PluginTool<FetchParams, string> = {
  name: 'web_fetch',
  description:
    'Fetch and extract readable content from a URL. Converts HTML to clean markdown. ' +
    'Use this to read articles, documentation, or any web page.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch (must be http or https)',
      },
      maxChars: {
        type: 'number',
        description: 'Maximum characters to return (default: 30000)',
      },
    },
    required: ['url'],
  },
  handler: async (input: FetchParams, _context: PluginContext): Promise<string> => {
    const result = await runWebFetch(input)

    // Format result for LLM
    const header = result.title
      ? `# ${result.title}\n\nSource: ${result.url}\n`
      : `Source: ${result.url}\n`

    const meta: string[] = []
    if (result.finalUrl && result.finalUrl !== result.url) {
      meta.push(`Redirected to: ${result.finalUrl}`)
    }
    if (result.truncated) {
      meta.push(`(content truncated)`)
    }
    if (result.cached) {
      meta.push(`(cached)`)
    }

    const metaLine = meta.length > 0 ? meta.join(' | ') + '\n\n' : '\n'

    return header + metaLine + '---\n\n' + result.text
  },
}

// =============================================================================
// Plugin Export
// =============================================================================

const plugin: ToolPlugin = {
  name: 'brave-search',
  description: 'Web search and fetch tools using Brave Search API',
  tools: [webSearchTool, webFetchTool],
}

export default plugin
