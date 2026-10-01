import { describe, expect, it } from 'vitest'
import { KnowledgeBase } from './base.js'

const base = new KnowledgeBase('config/knowledge/myqrlwallet.json')
describe('curated community knowledge retrieval', () => {
  it.each([
    ['How do I pair a dApp with a QR code?', 'connect'],
    ['Does QuantaPool still use stQRL?', 'quantapool'],
    ['Did ecdsa.fail break a Bitcoin private key?', 'ecdsa-fail'],
    ['What happened to QuantaProof?', 'quantastark'],
    ['How does Qloak hide transfers?', 'qnero'],
    ['Why does an XMSS wallet need OTS tracking?', 'qrl'],
    ['What is an ML-KEM key used for?', 'post-quantum'],
    ['How do HTLC refunds work?', 'quantaswap'],
    ['What is the QNS name service?', 'qns']
  ])('retrieves sources for %s', (query, expected) => {
    expect(base.search(query).map((topic) => topic.id)).toContain(expected)
    expect(base.context(query)).toContain('Reviewed: 2026-10-01')
    expect(base.context(query)).toContain('https://')
  })
  it('keeps ordinary chat context compact and does not ingest Git messages', () => {
    expect(base.search('hello friends')).toHaveLength(0)
    expect(base.context('hello friends').length).toBeLessThan(3500)
    expect(base.context('hello friends')).toContain('routine Git notifications are excluded')
  })
})
