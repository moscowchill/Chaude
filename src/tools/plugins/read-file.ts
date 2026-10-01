/**
 * Read File Plugin
 *
 * Provides tools for reading file contents from the local filesystem.
 * Supports text files (.txt, .md, .json, etc.) and PDFs.
 *
 * Tools:
 * - read_file: Read contents of a text or PDF file
 */

import { ToolPlugin, PluginTool, PluginContext } from './types.js'
import { createLogger } from '../../utils/logger.js'
import { extname } from 'path'
import { createRequire } from 'node:module'
import { readAllowedFile } from './safe-file.js'

const logger = createLogger({ plugin: 'read-file' })

// Maximum file size to read (10MB for text, 50MB for PDF)
const MAX_TEXT_FILE_SIZE = 10 * 1024 * 1024
const MAX_PDF_FILE_SIZE = 50 * 1024 * 1024

// Maximum characters to return (to avoid overwhelming the LLM context)
const MAX_OUTPUT_CHARS = 100_000

// Text file extensions we support
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown',
  '.json', '.yaml', '.yml', '.toml',
  '.xml', '.html', '.htm', '.css',
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.rb', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.hpp',
  '.sh', '.bash', '.zsh', '.fish',
  '.sql', '.graphql', '.gql',
  '.env', '.gitignore', '.dockerfile',
  '.csv', '.tsv', '.log',
  '.ini', '.cfg', '.conf', '.config',
])

interface ReadFileInput {
  path: string
  encoding?: string
  start_line?: number
  end_line?: number
}

// Dynamic import for pdf-parse (optional dependency)
// Using v1.x API which is more stable in Node.js
type PdfParseResult = { text: string; numPages: number }
type PdfParseFn = (buffer: Uint8Array) => Promise<{ text: string; numpages: number }>
let pdfParseFn: PdfParseFn | null | undefined = null

async function loadPdfParse(): Promise<PdfParseFn | null> {
  if (pdfParseFn === null) {
    try {
      // createRequire avoids pdf-parse's standalone debug branch under Node 22 ESM.
      const module: unknown = createRequire(import.meta.url)('pdf-parse')
      // The bundled pdf.js accepts Uint8Array; upstream typings only declare Buffer.
      pdfParseFn = module as PdfParseFn
    } catch {
      // pdf-parse not installed
      pdfParseFn = undefined
    }
  }
  return pdfParseFn ?? null
}

async function parsePdf(buffer: Buffer): Promise<PdfParseResult> {
  const parse = await loadPdfParse()
  if (!parse) {
    throw new Error('PDF support not available')
  }

  // pdf.js expects slice() to copy; Node Buffer.slice() returns a view.
  const result = await parse(new Uint8Array(buffer))
  return {
    text: result.text,
    numPages: result.numpages,
  }
}

const readFileTool: PluginTool<ReadFileInput, string> = {
  name: 'read_file',
  description: `Read a file from directories explicitly allowed by the server owner.

Supported file types:
- Text files: .txt, .md, .json, .yaml, .xml, .csv, .log, and most code files
- PDF files: .pdf (extracts text content)

Use start_line and end_line to read specific portions of large files.
Maximum output is ~100,000 characters (truncated if exceeded).`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or relative path to the file to read',
      },
      encoding: {
        type: 'string',
        description: 'Text encoding (default: utf-8). Common: utf-8, latin1, ascii',
      },
      start_line: {
        type: 'number',
        description: 'Start reading from this line number (1-indexed, inclusive)',
      },
      end_line: {
        type: 'number',
        description: 'Stop reading at this line number (1-indexed, inclusive)',
      },
    },
    required: ['path'],
  },
  handler: async (input: ReadFileInput, context: PluginContext): Promise<string> => {
    const { path, encoding = 'utf-8', start_line, end_line } = input

    logger.info({ path, encoding, start_line, end_line, channelId: context.channelId }, 'Reading file')

    try {
      const ext = extname(path).toLowerCase()
      const isPdf = ext === '.pdf'
      const maxSize = isPdf ? MAX_PDF_FILE_SIZE : MAX_TEXT_FILE_SIZE
      const buffer = await readAllowedFile(path, maxSize)

      let content: string

      if (isPdf) {
        // Handle PDF files
        const pdfParser = await loadPdfParse()
        if (!pdfParser) {
          return 'Error: PDF support not available. Install pdf-parse package: npm install pdf-parse'
        }

        const pdfData = await parsePdf(buffer)
        content = pdfData.text

        logger.debug({ path, pages: pdfData.numPages, textLength: content.length }, 'PDF parsed')

        // Add page count info
        const header = `[PDF: ${pdfData.numPages} pages]\n\n`
        content = header + content

      } else {
        // Handle text files
        const isTextFile = TEXT_EXTENSIONS.has(ext) || ext === '' || !ext
        if (!isTextFile) {
          // Try to read anyway but warn
          logger.warn({ path, ext }, 'Reading file with unknown extension as text')
        }

        content = buffer.toString(encoding as BufferEncoding)
      }

      // Apply line range if specified
      if (start_line !== undefined || end_line !== undefined) {
        const lines = content.split('\n')
        const start = Math.max(1, start_line ?? 1) - 1  // Convert to 0-indexed
        const end = Math.min(lines.length, end_line ?? lines.length)

        if (start >= lines.length) {
          return `Error: start_line (${start_line}) exceeds file length (${lines.length} lines)`
        }

        const selectedLines = lines.slice(start, end)
        content = selectedLines.join('\n')

        // Add line number info
        const header = `[Lines ${start + 1}-${Math.min(end, lines.length)} of ${lines.length}]\n\n`
        content = header + content
      }

      // Truncate if too long
      if (content.length > MAX_OUTPUT_CHARS) {
        const truncatedLength = content.length
        content = content.slice(0, MAX_OUTPUT_CHARS)
        content += `\n\n[... truncated, showing ${MAX_OUTPUT_CHARS.toLocaleString()} of ${truncatedLength.toLocaleString()} characters]`
      }

      logger.info({ path, size: buffer.length, outputLength: content.length }, 'File read successfully')

      return content

    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error({ error: message, path }, 'Failed to read file')
      return `Error reading file: ${message}`
    }
  },
}

const plugin: ToolPlugin = {
  name: 'read-file',
  description: 'Read contents of text files (.txt, .md, etc.) and PDFs from the local filesystem',
  tools: [readFileTool],
}

export default plugin
