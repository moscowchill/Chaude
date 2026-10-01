import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { fetchPublicPage, isPublicAddress } from './safe-fetch.js'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))
vi.mock('node:http', () => ({ request: vi.fn() }))
vi.mock('node:https', () => ({ request: vi.fn() }))

beforeEach(() => {
  vi.resetAllMocks()
})

describe('public address policy', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '0.0.0.0',
    '169.254.169.254',
    '172.16.1.1',
    '192.168.1.1',
    '100.64.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    '2001:db8::1',
    '3fff::1'
  ])('blocks %s', (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })
  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])('permits %s', (address) => {
    expect(isPublicAddress(address)).toBe(true)
  })
})

function respond(status: number, headers: Record<string, string>, body: string) {
  vi.mocked(request).mockImplementationOnce((url, options, callback) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void }
    req.end = () => {
      const res = Object.assign(new PassThrough(), { statusCode: status, headers })
      callback!(res)
      queueMicrotask(() => res.end(body))
    }
    return req
  })
}

describe('web fetching', () => {
  it.each([
    'http://127.0.0.1/',
    'http://2130706433/',
    'http://[::ffff:127.0.0.1]/',
    'file:///etc/passwd',
    'https://user:pass@example.com',
    'https://example.com:8443/'
  ])('blocks unsafe URL %s before connecting', async (url) => {
    await expect(fetchPublicPage(url)).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects names resolving to private or mixed public/private addresses', async () => {
    vi.mocked(lookup).mockResolvedValue([
      { address: '1.1.1.1', family: 4 },
      { address: '127.0.0.1', family: 4 }
    ])
    await expect(fetchPublicPage('https://example.com')).rejects.toThrow('public Internet')
    expect(request).not.toHaveBeenCalled()
  })

  it('fetches a public page and pins the checked IP for the connection', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '1.1.1.1', family: 4 }])
    respond(200, { 'content-type': 'text/plain' }, 'A public document')
    const page = await fetchPublicPage('https://example.com/Document')
    expect(page.body).toBe('A public document')
    expect(page.url).toBe('https://example.com/Document')
    const options = vi.mocked(request).mock.calls[0][1]
    const callback = vi.fn()
    options.lookup('example.com', {}, callback)
    expect(callback).toHaveBeenCalledWith(null, '1.1.1.1', 4)
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(options.agent).toBe(false)
  })

  it('blocks a public page redirecting to a private service', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '1.1.1.1', family: 4 }])
    respond(302, { location: 'http://127.0.0.1/' }, '')
    await expect(fetchPublicPage('https://example.com')).rejects.toThrow('public Internet')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('checks DNS again on redirects and rejects rebinding', async () => {
    vi.mocked(lookup)
      .mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }])
      .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }])
    respond(302, { location: '/next' }, '')
    await expect(fetchPublicPage('https://example.com')).rejects.toThrow('public Internet')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('bounds the response body', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '1.1.1.1', family: 4 }])
    respond(200, { 'content-type': 'text/plain' }, 'x'.repeat(2 * 1024 * 1024 + 1))
    await expect(fetchPublicPage('https://example.com')).rejects.toThrow('2 MiB')
  })

  it('times out even if DNS never replies', async () => {
    vi.mocked(lookup).mockImplementation(() => new Promise(() => {}))
    await expect(fetchPublicPage('https://example.com', 10)).rejects.toThrow('timed out')
    expect(request).not.toHaveBeenCalled()
  })

  it('follows a redirect to another public page', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '1.1.1.1', family: 4 }])
    respond(302, { location: '/destination' }, '')
    respond(200, { 'content-type': 'text/plain' }, 'Redirected document')
    const page = await fetchPublicPage('https://example.com')
    expect(page.body).toBe('Redirected document')
    expect(page.url).toBe('https://example.com/destination')
    expect(lookup).toHaveBeenCalledTimes(2)
  })
})
