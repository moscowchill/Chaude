/**
 * Brave Search Plugin Utilities
 *
 * HTML extraction and text processing utilities for web_fetch.
 */

export type ExtractMode = 'markdown' | 'text'

/**
 * Decode common HTML entities
 */
function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/gi, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
}

/**
 * Strip HTML tags from text
 */
function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, ''))
}

/**
 * Normalize whitespace in text
 */
function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/**
 * Convert HTML to simple markdown
 */
export function htmlToMarkdown(html: string): { text: string; title?: string } {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch?.[1] ? normalizeWhitespace(stripTags(titleMatch[1])) : undefined

  // Remove script/style/noscript
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')

  // Convert links
  text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, body) => {
    const label = normalizeWhitespace(stripTags(body))
    if (!label) return href
    return `[${label}](${href})`
  })

  // Convert headings
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, body: string) => {
    const prefix = '#'.repeat(Math.max(1, Math.min(6, parseInt(level, 10))))
    const label = normalizeWhitespace(stripTags(body))
    return `\n${prefix} ${label}\n`
  })

  // Convert list items
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => {
    const label = normalizeWhitespace(stripTags(body))
    return label ? `\n- ${label}` : ''
  })

  // Convert code blocks
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, body) => {
    const code = normalizeWhitespace(stripTags(body))
    return `\n\`\`\`\n${code}\n\`\`\`\n`
  })

  // Convert inline code
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, body) => {
    const code = stripTags(body)
    return `\`${code}\``
  })

  // Convert breaks and block elements
  text = text
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|table|tr|ul|ol)>/gi, '\n')

  // Strip remaining tags
  text = stripTags(text)
  text = normalizeWhitespace(text)

  return { text, title }
}

/**
 * Convert markdown to plain text
 */
export function markdownToText(markdown: string): string {
  let text = markdown
  // Remove images
  text = text.replace(/!\[[^\]]*]\([^)]+\)/g, '')
  // Convert links to just text
  text = text.replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
  // Remove code blocks
  text = text.replace(/```[\s\S]*?```/g, block =>
    block.replace(/```[^\n]*\n?/g, '').replace(/```/g, '')
  )
  // Remove inline code markers
  text = text.replace(/`([^`]+)`/g, '$1')
  // Remove heading markers
  text = text.replace(/^#{1,6}\s+/gm, '')
  // Remove list markers
  text = text.replace(/^\s*[-*+]\s+/gm, '')
  text = text.replace(/^\s*\d+\.\s+/gm, '')

  return normalizeWhitespace(text)
}

/**
 * Truncate text to max length
 */
export function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false }
  return { text: value.slice(0, maxChars) + '\n\n[truncated]', truncated: true }
}

/**
 * Extract readable content using @mozilla/readability
 */
export async function extractReadableContent(params: {
  html: string
  url: string
  extractMode: ExtractMode
}): Promise<{ text: string; title?: string } | null> {
  const fallback = (): { text: string; title?: string } => {
    const rendered = htmlToMarkdown(params.html)
    if (params.extractMode === 'text') {
      const text = markdownToText(rendered.text) || normalizeWhitespace(stripTags(params.html))
      return { text, title: rendered.title }
    }
    return rendered
  }

  try {
    const [{ Readability }, { parseHTML }] = await Promise.all([
      import('@mozilla/readability'),
      import('linkedom'),
    ])

    const { document } = parseHTML(params.html)

    // Try to set base URI for relative links
    try {
      (document as { baseURI?: string }).baseURI = params.url
    } catch {
      // Best-effort
    }

    const reader = new Readability(document, { charThreshold: 0 })
    const parsed = reader.parse()

    if (!parsed?.content) return fallback()

    const title = parsed.title || undefined

    if (params.extractMode === 'text') {
      const text = normalizeWhitespace(parsed.textContent ?? '')
      return text ? { text, title } : fallback()
    }

    const rendered = htmlToMarkdown(parsed.content)
    return { text: rendered.text, title: title ?? rendered.title }
  } catch {
    return fallback()
  }
}
