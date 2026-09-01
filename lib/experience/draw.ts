// The mathematical core of the capsule draw. PURE — no imports, no crypto, no
// Redis — so scripts/verify-experience.ts can execute every branch directly
// under `node --experimental-strip-types`, and so the same functions render the
// published odds table on the server and drive the actual selection.
//
// THAT SHARING IS THE POINT. The industry-standard "provably fair" seed scheme
// proves only that an outcome was derived from a pre-committed seed; it says
// nothing about whether the advertised probabilities match the table the seed
// indexes into, and sites have shipped "provably fair" over rigged tables for
// exactly that reason. Here `deriveOdds` and `selectByHash` read the SAME
// snapshot array, so the disclosure and the draw cannot disagree — there is no
// second table to rig.

import type { OddsRow, PoolEntry, SnapshotEntry } from './types'

/** Upper bound on a single entry's weight. Keeps Σweight far inside Number's
 *  exact-integer range for any plausible pool, so the cumulative walk below
 *  never loses precision, and bounds what a corrupt or hostile config can
 *  express. */
export const MAX_WEIGHT = 1_000_000

/** Upper bound on pool size. Matches lib/splits.MAX_SPLITS because every pool
 *  artist must appear in the machine's split (an artist who cannot be paid must
 *  not be drawable), so the split cap is the real ceiling on distinct artists.
 *  A pool may hold several pieces by one artist, hence the separate, larger
 *  entry cap. */
export const MAX_POOL_ARTISTS = 50
export const MAX_POOL_ENTRIES = 200

/** Is this entry structurally drawable? Weight must be a positive integer
 *  within bounds, and remaining must not be exhausted. `remaining: null` means
 *  unlimited supply (an open edition), which is always drawable.
 *
 *  Rejects rather than coerces: a NaN or negative weight is a corrupted or
 *  hostile row, and silently treating it as 1 would let a bad write quietly
 *  reshape a published distribution. */
export function isDrawable(e: SnapshotEntry): boolean {
  if (!Number.isInteger(e.weight) || e.weight <= 0 || e.weight > MAX_WEIGHT) return false
  if (e.remaining === null) return true
  return Number.isInteger(e.remaining) && e.remaining > 0
}

/** The drawable subset, order preserved. Order is load-bearing: selection walks
 *  cumulative weights in array order, so a stable order makes a draw reproducible
 *  from the stored snapshot alone. */
export function eligible(snapshot: SnapshotEntry[]): SnapshotEntry[] {
  return snapshot.filter(isDrawable)
}

/** Σ weight over drawable entries. 0 means nothing can be drawn — the caller
 *  must treat that as a pool failure, never as a reason to pick arbitrarily. */
export function totalWeight(snapshot: SnapshotEntry[]): number {
  let sum = 0
  for (const e of eligible(snapshot)) sum += e.weight
  return sum
}

/**
 * The published odds table. Probabilities are derived here and NOWHERE else —
 * no creator input reaches this function except through `weight`, which is also
 * what the draw consumes.
 *
 * Exhausted entries are returned with probability 0 rather than dropped, so a
 * player can still see that a piece existed and is gone; hiding it would let a
 * machine quietly become a different machine than the one advertised.
 */
export function deriveOdds(snapshot: SnapshotEntry[]): OddsRow[] {
  const total = totalWeight(snapshot)
  return snapshot.map((e) => ({
    collection: e.collection,
    tokenId: e.tokenId,
    artist: e.artist,
    probability: total > 0 && isDrawable(e) ? e.weight / total : 0,
    remaining: e.remaining,
  }))
}

/** Odds rows sum to 1 (within float tolerance) whenever anything is drawable.
 *  Exported so the oracle and a runtime assertion can share one definition of
 *  "the table is coherent". */
export function oddsAreCoherent(rows: OddsRow[]): boolean {
  const sum = rows.reduce((a, r) => a + r.probability, 0)
  if (sum === 0) return rows.every((r) => r.probability === 0)
  return Math.abs(sum - 1) < 1e-9
}

/**
 * Weighted selection from a 32-byte hex hash (an HMAC over the committed seed
 * and this play's transaction — see lib/experience/fairness).
 *
 * Takes the first 16 hex-bytes (128 bits) as a BigInt and reduces modulo the
 * total weight. Modulo bias is bounded by ~totalWeight / 2^128; with weights
 * capped at 1e6 and pools at 200 entries, Σweight < 2^28, so the bias is under
 * 2^-100 — immeasurably smaller than any real-world source of unfairness, and
 * far cheaper than rejection sampling, which would make a draw's cost
 * probabilistic and therefore its latency unpredictable on a paid action.
 *
 * Returns null when nothing is drawable, so callers must handle pool failure
 * explicitly rather than receiving an arbitrary entry.
 */
export function selectByHash(
  snapshot: SnapshotEntry[],
  hashHex: string,
): SnapshotEntry | null {
  const pool = eligible(snapshot)
  if (pool.length === 0) return null
  const total = pool.reduce((a, e) => a + e.weight, 0)
  if (total <= 0) return null

  const clean = hashHex.startsWith('0x') ? hashHex.slice(2) : hashHex
  if (!/^[0-9a-fA-F]{32,}$/.test(clean)) return null
  const target = Number(BigInt('0x' + clean.slice(0, 32)) % BigInt(total))

  let cursor = 0
  for (const e of pool) {
    cursor += e.weight
    if (target < cursor) return e
  }
  // Unreachable while cursor sums to `total` and target < total; returning the
  // last entry rather than null keeps a float/precision surprise from turning a
  // paid play into a pool failure.
  return pool[pool.length - 1]
}

/** Apply a successful draw to a snapshot: decrement the drawn entry's remaining
 *  count. Pure — the caller performs the authoritative atomic decrement in Redis
 *  (HINCRBY) and uses this only to keep an in-memory snapshot consistent for a
 *  redraw attempt. */
export function withDecrement(
  snapshot: SnapshotEntry[],
  drawn: { collection: string; tokenId: string },
): SnapshotEntry[] {
  return snapshot.map((e) =>
    e.collection === drawn.collection && e.tokenId === drawn.tokenId && e.remaining !== null
      ? { ...e, remaining: Math.max(0, e.remaining - 1) }
      : e,
  )
}

/** Remove an entry from a snapshot entirely — used when a live authority
 *  re-check fails (grant revoked, token minted out, artwork hidden) and the
 *  entry must not be reconsidered on the redraw attempt. */
export function withExcluded(
  snapshot: SnapshotEntry[],
  excluded: { collection: string; tokenId: string },
): SnapshotEntry[] {
  return snapshot.filter(
    (e) => !(e.collection === excluded.collection && e.tokenId === excluded.tokenId),
  )
}

/** Canonical key for a pool entry — the member form used by every Redis hash
 *  and the cross-machine commitment ledger. */
export function entryKey(e: { collection: string; tokenId: string }): string {
  return `${e.collection.toLowerCase()}:${e.tokenId}`
}

/** Distinct artists in a pool, lowercased — the set that must appear in the
 *  machine's split, and the set the MAX_POOL_ARTISTS cap applies to. */
export function poolArtists(entries: PoolEntry[]): string[] {
  const seen = new Set<string>()
  for (const e of entries) seen.add(e.artist.toLowerCase())
  return [...seen]
}
