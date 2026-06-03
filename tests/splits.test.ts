import { describe, it, expect } from 'vitest'
import { validateSplitsArray } from '@/lib/splits'

// Revenue routing: a bug here mis-pays creators. validateSplitsArray is the
// server-side gate before splits reach SplitMain, so its invariants matter.
const A = '0x' + '1'.repeat(40)
const B = '0x' + '2'.repeat(40)

describe('validateSplitsArray', () => {
  it('accepts two valid recipients summing to 100 and returns them sorted', () => {
    const r = validateSplitsArray([
      { address: B, percentAllocation: 50 },
      { address: A, percentAllocation: 50 },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.splits).toHaveLength(2)
      // SplitMain requires ascending-by-address ordering.
      expect(r.splits[0].address.toLowerCase()).toBe(A)
      expect(r.splits[1].address.toLowerCase()).toBe(B)
    }
  })

  it('rejects a non-array', () => {
    expect(validateSplitsArray('nope')).toMatchObject({ ok: false })
  })

  it('rejects fewer than 2 recipients', () => {
    const r = validateSplitsArray([{ address: A, percentAllocation: 100 }])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/at least 2/)
  })

  it('rejects allocations that do not sum to 100', () => {
    const r = validateSplitsArray([
      { address: A, percentAllocation: 50 },
      { address: B, percentAllocation: 40 },
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/sum to 100/)
  })

  it('rejects duplicate addresses', () => {
    const r = validateSplitsArray([
      { address: A, percentAllocation: 50 },
      { address: A, percentAllocation: 50 },
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/duplicate/)
  })

  it('rejects non-integer / out-of-range allocations', () => {
    expect(
      validateSplitsArray([
        { address: A, percentAllocation: 50.5 },
        { address: B, percentAllocation: 49.5 },
      ]).ok,
    ).toBe(false)
    expect(
      validateSplitsArray([
        { address: A, percentAllocation: 0 },
        { address: B, percentAllocation: 100 },
      ]).ok,
    ).toBe(false)
  })

  it('rejects malformed addresses', () => {
    const r = validateSplitsArray([
      { address: '0xnothex', percentAllocation: 50 },
      { address: B, percentAllocation: 50 },
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/address/)
  })
})
