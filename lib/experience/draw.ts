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

/** Upper bound on plays one capsule transaction can carry. A Zora mint's
 *  quantity is unbounded on-chain, so this is OUR ceiling, and it must be the
 *  same number everywhere a unit index is validated or probed — the play route,
 *  the resume and verify routes, the claims and discovery probes, and the
 *  client's open loop. Three different ceilings (999 / 20 / 20) once let a
 *  50-unit capsule be playable by API but only 20-recoverable by UI.
 *
 *  Units past it are PAID FOR AND UNPLAYABLE, so the number is set by what a
 *  transaction could plausibly carry, not by what the product offers (×10 at
 *  most): every loop it bounds is already bounded by real claims or real minted
 *  units, so a large value costs nothing until someone actually buys that many
 *  in one transaction — and then it costs them a long sequence of reveals,
 *  which is theirs to have bought. Set to a hundred times the largest pull. */
export const MAX_UNITS_PER_CAPSULE = 1000

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

/**
 * What a draw picks at `attempt`, and which pieces the attempts before it set
 * aside — recomputed from the frozen snapshot and the per-attempt hashes alone.
 *
 * The draw loop (runDraw) only moves past an attempt by REFUSING its pick — a
 * lost race for the last copy, or a failed live authority check — and it drops
 * exactly that pick before drawing again. So the table attempt N draws from is
 * the snapshot minus the picks of attempts 0..N-1, all of which are public.
 * runDraw selects through this function and the verifier replays through it,
 * so the two cannot disagree about which rows a redraw left out. A verifier
 * that recomputed the final attempt over the whole snapshot instead reported
 * MISMATCH for most honest redraws.
 */
export function drawAtAttempt(
  snapshot: SnapshotEntry[],
  hashAt: (attempt: number) => string,
  attempt: number,
): { pick: SnapshotEntry | null; setAside: SnapshotEntry[] } {
  let working = snapshot
  const setAside: SnapshotEntry[] = []
  for (let k = 0; k < attempt; k++) {
    const refused = selectByHash(working, hashAt(k))
    if (!refused) return { pick: null, setAside }
    setAside.push(refused)
    working = withExcluded(working, refused)
  }
  return { pick: selectByHash(working, hashAt(attempt)), setAside }
}

/**
 * A reveal machine's pull: a uniform index in [0, n), from the platform's
 * cryptographic randomness. Modulo of a 32-bit value, so the bias is n / 2^32 —
 * under one in twenty million for the largest lineup. A pull is free and sells
 * nothing, so it needs no commitment; it needs only to be fair, which is what
 * the published 1-in-N says it is.
 */
export function pickIndex(n: number): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] % n
}

/**
 * Could handing out one more copy from this table leave nothing drawable?
 * True only when at most one copy is left across every drawable piece. The
 * "has this machine run empty?" check re-reads the whole pool and the chain,
 * so it is asked only when a play's own frozen table says the answer could be
 * yes — the play that takes the last copy, or one that found none. An open
 * edition never runs out.
 */
export function mayRunDry(table: SnapshotEntry[]): boolean {
  let left = 0
  for (const e of table) {
    if (!isDrawable(e)) continue
    if (e.remaining === null) return false
    left += e.remaining
    if (left > 1) return false
  }
  return true
}

/**
 * A snapshot as the chain stands: pieces the delivery account may no longer
 * mint, or that have no copies left on-chain, are dropped, and each piece's
 * remaining count is clamped to the copies that actually exist. A piece with
 * no standing (its reads failed) is dropped too — fail closed. Order is kept,
 * because selection walks the array in order.
 */
export function withLiveStanding(
  snapshot: SnapshotEntry[],
  standing: Record<string, { left: number | null; granted: boolean }>,
): SnapshotEntry[] {
  const out: SnapshotEntry[] = []
  for (const e of snapshot) {
    const s = standing[entryKey(e)]
    if (!s || !s.granted || s.left === 0) continue
    const remaining = s.left === null ? e.remaining : e.remaining === null ? s.left : Math.min(e.remaining, s.left)
    out.push({ ...e, remaining })
  }
  return out
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
