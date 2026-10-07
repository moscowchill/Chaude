import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { delimiter, isAbsolute, parse, relative, resolve, sep } from 'node:path'

/** Only the host environment can grant access to curated, non-secret directories. */
export async function readAllowedFile(path: string, maxBytes: number): Promise<Buffer> {
  const configured = (process.env.READ_FILE_ALLOWED_DIRS ?? '').split(delimiter).filter(Boolean)
  if (configured.length === 0) throw new Error('Local file access is disabled')
  if (configured.some((root) => !isAbsolute(root) || resolve(root) === parse(root).root)) {
    throw new Error('File access requires explicit absolute directories')
  }

  const roots = await Promise.all(configured.map((root) => realpath(root)))
  if (roots.some((root) => root === parse(root).root)) {
    throw new Error('File access requires explicit absolute directories')
  }
  const target = await realpath(path)
  const permitted = roots.some((root) => {
    const child = relative(root, target)
    return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
  })
  if (!permitted) throw new Error('File is outside the allowed directories')

  // Open the resolved path and reject a replacement symlink at the final component.
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stats = await file.stat()
    if (!stats.isFile()) throw new Error('Only regular files may be read')
    if (stats.size > maxBytes) throw new Error('File exceeds the size limit')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of file.createReadStream({
      start: 0,
      end: maxBytes,
      autoClose: false
    })) {
      const bytes = chunk as Buffer
      size += bytes.length
      if (size > maxBytes) throw new Error('File exceeds the size limit')
      chunks.push(bytes)
    }
    return Buffer.concat(chunks)
  } finally {
    await file.close()
  }
}
