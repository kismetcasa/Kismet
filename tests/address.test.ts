import { describe, it, expect } from 'vitest'
import { isAddress, isValidTokenId } from '@/lib/address'

describe('isAddress (non-strict, server-side)', () => {
  it('accepts well-formed hex regardless of case', () => {
    expect(isAddress('0x' + 'a'.repeat(40))).toBe(true)
    expect(isAddress('0x' + '1'.repeat(40))).toBe(true)
    expect(isAddress('0x' + 'A'.repeat(40))).toBe(true)
  })
  it('rejects malformed or non-string input', () => {
    expect(isAddress('0x123')).toBe(false)
    expect(isAddress('not-an-address')).toBe(false)
    expect(isAddress(123)).toBe(false)
    expect(isAddress(null)).toBe(false)
    expect(isAddress(undefined)).toBe(false)
  })
})

describe('isValidTokenId', () => {
  it('accepts decimal-string ids', () => {
    expect(isValidTokenId('123')).toBe(true)
    expect(isValidTokenId('0')).toBe(true)
  })
  it('rejects empty, non-decimal, or non-string', () => {
    expect(isValidTokenId('')).toBe(false)
    expect(isValidTokenId('1a')).toBe(false)
    expect(isValidTokenId(5)).toBe(false)
  })
})
