import { lookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'

const blocked = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const)
  blocked.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20]
] as const)
  blocked.addSubnet(address, prefix, 'ipv6')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !blocked.check(address, 'ipv4')
  // Reject mapped IPv4, local, multicast, NAT64 and transition addresses.
  return family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
}

interface Page {
  url: string
  contentType: string
  body: string
}

function resolveHost(host: string, signal: AbortSignal): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Fetch timed out during DNS resolution'))
    signal.addEventListener('abort', abort, { once: true })
    lookup(host, { all: true })
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener('abort', abort)
      })
  })
}

/** Resolve, validate, then pin the socket to the checked address on every redirect. */
export async function fetchPublicPage(input: string, timeoutMs = 30_000): Promise<Page> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let url = new URL(input)
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
        throw new Error('Only HTTP(S) URLs on their default ports without credentials are allowed')
      }
      const host = url.hostname.replace(/^\[|\]$/g, '')
      const literalFamily = isIP(host)
      const addresses = literalFamily
        ? [{ address: host, family: literalFamily }]
        : await resolveHost(host, controller.signal)
      if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) {
        throw new Error('URL must resolve exclusively to public Internet addresses')
      }
      controller.signal.throwIfAborted()
      const selected = addresses[0]!
      const response = await new Promise<Page & { location?: string }>((resolve, reject) => {
        const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
          url,
          {
            method: 'GET',
            agent: false,
            family: selected.family,
            // No second DNS lookup may choose a different, unchecked address.
            lookup: (_hostname, _options, callback) =>
              callback(null, selected.address, selected.family),
            signal: controller.signal,
            headers: {
              Accept: 'text/html, text/plain, application/json',
              'Accept-Encoding': 'identity',
              'User-Agent': 'Chaude/1.0'
            }
          },
          (res) => {
            const status = res.statusCode ?? 0
            if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
              resolve({ url: url.href, contentType: '', body: '', location: res.headers.location })
              res.destroy()
              return
            }
            if (status < 200 || status >= 300) {
              reject(new Error(`Fetch failed (${status})`))
              res.destroy()
              return
            }
            const chunks: Buffer[] = []
            let size = 0
            res.on('data', (chunk: Buffer) => {
              size += chunk.length
              if (size > 2 * 1024 * 1024) {
                const error = new Error('Response exceeds the 2 MiB limit')
                reject(error)
                res.destroy(error)
              } else chunks.push(chunk)
            })
            res.on('error', reject)
            res.on('end', () =>
              resolve({
                url: url.href,
                contentType: res.headers['content-type'] ?? 'application/octet-stream',
                body: Buffer.concat(chunks).toString('utf8')
              })
            )
          }
        )
        request.on('error', reject)
        request.end()
      })
      if (!response.location) return response
      url = new URL(response.location, url)
    }
    throw new Error('Too many redirects')
  } finally {
    clearTimeout(timeout)
  }
}
