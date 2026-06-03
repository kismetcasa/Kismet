import { describe, it, expect } from 'vitest'
import {
  formatPrice,
  inferCollectCurrency,
  isPlatformCollectComment,
  shortAddress,
  resolveUri,
} from '@/lib/inprocess'

describe('formatPrice', () => {
  it('formats ETH base units (wei)', () => {
    expect(formatPrice('100000000000000000', 'eth')).toBe('0.1 ETH')
    expect(formatPrice('1500000000000000000', 'eth')).toBe('1.5 ETH')
  })
  it('formats USDC base units (6 decimals)', () => {
    expect(formatPrice('5000000', 'usdc')).toBe('$5')
    expect(formatPrice('5500000', 'usdc')).toBe('$5.5')
  })
  it('formats already-decimal strings (the dot triggers the decimal path)', () => {
    expect(formatPrice('0.1', 'eth')).toBe('0.1 ETH')
    // Trailing-zero trim: "5.0" → "$5". (A dot-less "5" is treated as base
    // units, not 5 USDC — covered by the base-units case above.)
    expect(formatPrice('5.0', 'usdc')).toBe('$5')
  })
  it('returns "free" for zero and "" for empty', () => {
    expect(formatPrice('0', 'eth')).toBe('free')
    expect(formatPrice('', 'eth')).toBe('')
  })
})

describe('inferCollectCurrency', () => {
  it('maps the sale type', () => {
    expect(inferCollectCurrency({ type: 'erc20Mint' })).toBe('usdc')
    expect(inferCollectCurrency({ type: 'fixedPrice' })).toBe('eth')
  })
  it('defaults to eth', () => {
    expect(inferCollectCurrency({})).toBe('eth')
  })
})

describe('isPlatformCollectComment', () => {
  it('treats empty + default + legacy strings as platform-default', () => {
    expect(isPlatformCollectComment('')).toBe(true)
    expect(isPlatformCollectComment('collected on kismet')).toBe(true)
    expect(isPlatformCollectComment('collected via kismet')).toBe(true)
  })
  it('treats a real comment as non-default', () => {
    expect(isPlatformCollectComment('gm, love this')).toBe(false)
  })
})

describe('shortAddress / resolveUri', () => {
  it('shortens an address', () => {
    expect(shortAddress('0x349D3DA472BDD2FBeebf8e0bBAF4220160A62526')).toBe('0x349D…2526')
    expect(shortAddress('')).toBe('')
  })
  it('resolves ar:// and ipfs:// to gateway URLs', () => {
    expect(resolveUri('ar://abc')).toBe('https://arweave.net/abc')
    expect(resolveUri('ipfs://cid')).toBe('https://ipfs.io/ipfs/cid')
    expect(resolveUri('https://x/y')).toBe('https://x/y')
  })
})
