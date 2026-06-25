// Pure splits-allocation math: the integer-rounding + residencies-scaling logic
// that builds the on-chain SplitMain recipient array. Extracted from MintForm so
// it can be unit-verified (scripts/verify-mint.ts) and reused without importing a
// React component. IMPORT-FREE on purpose — it must load under
// `node --experimental-strip-types` in CI, so it pulls in no redis/viem deps.
//
// THE BUG IT GUARDS: inprocess's splits endpoint requires INTEGER
// `percentAllocation` summing to EXACTLY 100. We once emitted decimals (the 47.5
// from scaling a 50/50 split by 0.95 to make room for a 5% residencies cut),
// which reverted the on-chain SplitMain setup. roundToIntegerAllocations +
// computeFinalSplits guarantee integers summing to the target on every path.

export interface Split {
  address: string
  percentAllocation: number
}

// 0xSplits' SplitMain requires `accounts` sorted ascending by address.
// Lowercase-compare on the hex string gives the same ordering as numeric
// ascending for properly-formed addresses.
export function sortSplits(s: Split[]): Split[] {
  return [...s].sort((a, b) => {
    const al = a.address.toLowerCase()
    const bl = b.address.toLowerCase()
    return al < bl ? -1 : al > bl ? 1 : 0
  })
}

// Convert fractional `values` (which by construction sum to ~`target`) into
// integers that sum to EXACTLY `target`, with every entry >= 1. Largest-
// remainder method: floor (min 1), then hand out / claw back the leftover by
// fractional remainder. Exact and order-stable — unlike a bounded +/-1 drift
// loop, it can't leave the sum off-target for skewed allocations (e.g. many
// tiny recipients plus one large one). Precondition: target >= values.length,
// which callers guarantee via the recipient cap + residenciesOverCap, so a
// min-1 solution always exists; the guards below just prevent a spin if it is
// ever violated (handleMint's sum check is the final backstop).
export function roundToIntegerAllocations(values: number[], target: number): number[] {
  const n = values.length
  if (n === 0) return []
  const ints = values.map((v) => Math.max(1, Math.floor(v)))
  let sum = ints.reduce((a, b) => a + b, 0)
  if (sum === target) return ints
  // Indices ordered by fractional remainder: add to the largest first,
  // remove from the smallest first, so the integer split best tracks intent.
  const byRemainder = values
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => a.frac - b.frac)
  if (sum < target) {
    let k = n - 1
    while (sum < target) {
      ints[byRemainder[((k % n) + n) % n].i] += 1
      sum += 1
      k -= 1
    }
  } else {
    let k = 0
    let guard = 0
    const maxGuard = sum * n + n
    while (sum > target && guard++ < maxGuard) {
      const { i } = byRemainder[k % n]
      if (ints[i] > 1) {
        ints[i] -= 1
        sum -= 1
      }
      k += 1
    }
  }
  return ints
}

// Builds the final splits array MintForm sends to inprocess. Every path emits
// integers summing to EXACTLY 100 (or undefined when there's no split to make).
// `p` = residenciesPercent (creator-chosen whole percent, 1..residenciesMax).
//
//   residencies OFF + 0/1 custom  -> undefined (caller uses payoutRecipient)
//   residencies OFF + 2+ custom   -> sorted custom splits (rounded to integers)
//   residencies ON  + 0/1 custom  -> [creator 100-p, residencies p] (sorted)
//   residencies ON  + 2+ custom   -> custom scaled x(100-p)/100 to integers
//                                    summing to 100-p, plus residencies p
export function computeFinalSplits(
  custom: Split[],
  residenciesEnabled: boolean,
  residenciesPercent: number,
  creatorAddress: string,
  residenciesAddress: string,
): Split[] | undefined {
  if (!residenciesEnabled) {
    if (custom.length < 2) return undefined
    const rounded = roundToIntegerAllocations(custom.map((s) => s.percentAllocation), 100)
    return sortSplits(custom.map((s, i) => ({ address: s.address, percentAllocation: rounded[i] })))
  }
  const p = residenciesPercent
  if (custom.length < 2) {
    return sortSplits([
      { address: creatorAddress, percentAllocation: 100 - p },
      { address: residenciesAddress, percentAllocation: p },
    ])
  }
  const rounded = roundToIntegerAllocations(
    custom.map((s) => (s.percentAllocation * (100 - p)) / 100),
    100 - p,
  )
  return sortSplits([
    ...custom.map((s, i) => ({ address: s.address, percentAllocation: rounded[i] })),
    { address: residenciesAddress, percentAllocation: p },
  ])
}
