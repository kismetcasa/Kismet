/**
 * Sweep ranking — the pure ordering half of the sweep index (lib/sweepIndex.ts).
 *
 * "Cheapest" is per-edition OUTLAY (pricePerToken + the collection's protocol
 * mint fee — exactly the `value` buildEthMintCall puts on the sub-call), never
 * the sticker price: a 0.0001 ETH mint costs 0.000211 ETH all-in, so ranking on
 * price alone mis-orders sub-dollar mints. Within one price tier (equal outlay)
 * ARTISTS INTERLEAVE — no single wallet can fill the basket from a tier while
 * another artist is available at the same price — then newest first, then a
 * stable key. That interleave is the only diversity rule; a per-artist cap and
 * a price floor were weighed and not built (SWEEP_IMPLEMENTATION.md §8).
 *
 * Zero imports on purpose: a pure function of its inputs, unit-verifiable under
 * --experimental-strip-types. Paid-ness (price > 0) is NOT decided here — the
 * index builder never constructs a free item (lib/sweepIndexCore.buildSweepItem).
 */

export interface RankableSweepItem {
  address: string
  tokenId: string
  /** Per-edition outlay in wei: pricePerToken + the collection's mint fee. */
  outlayWei: bigint
  /** Folded artist identity (smart wallet → owner EOA); null = unattributed. */
  artist: string | null
  /** First-seen mint instant, epoch ms; null when unknown. */
  createdAtMs: number | null
}

const keyOf = (it: RankableSweepItem): string => `${it.address.toLowerCase()}:${it.tokenId}`

/** Outlay ascending, then newest first (unknown dates last), then key
 *  ascending — a total order, so the sort is deterministic for any input order. */
function compareBase(a: RankableSweepItem, b: RankableSweepItem): number {
  if (a.outlayWei !== b.outlayWei) return a.outlayWei < b.outlayWei ? -1 : 1
  const ta = a.createdAtMs ?? Number.NEGATIVE_INFINITY
  const tb = b.createdAtMs ?? Number.NEGATIVE_INFINITY
  if (ta !== tb) return ta > tb ? -1 : 1
  const ka = keyOf(a)
  const kb = keyOf(b)
  return ka < kb ? -1 : ka > kb ? 1 : 0
}

/**
 * Round-robin one equal-outlay tier across artists. `tier` arrives in
 * compareBase order, so each artist's items are already newest-first and the
 * artist order is by each artist's newest item. Unattributed items form
 * singleton groups (two unknowns are never merged into one "artist").
 */
function interleaveTier<T extends RankableSweepItem>(tier: readonly T[]): T[] {
  const groups: T[][] = []
  const byArtist = new Map<string, T[]>()
  for (const it of tier) {
    if (it.artist === null) {
      groups.push([it])
      continue
    }
    const a = it.artist.toLowerCase()
    let g = byArtist.get(a)
    if (!g) {
      g = []
      byArtist.set(a, g)
      groups.push(g)
    }
    g.push(it)
  }
  const out: T[] = []
  for (let round = 0; out.length < tier.length; round++) {
    for (const g of groups) if (round < g.length) out.push(g[round])
  }
  return out
}

/**
 * Order sweep candidates cheapest-first. Returns EVERY eligible item in rank
 * order (callers slice N) so the same call serves the pool cut and the serve
 * prefix. See the module header for the tie-break.
 */
export function rankSweepCandidates<T extends RankableSweepItem>(items: readonly T[]): T[] {
  const eligible: T[] = [...items]
  eligible.sort(compareBase)

  const ordered: T[] = []
  for (let i = 0; i < eligible.length; ) {
    let j = i + 1
    while (j < eligible.length && eligible[j].outlayWei === eligible[i].outlayWei) j++
    ordered.push(...interleaveTier(eligible.slice(i, j)))
    i = j
  }
  return ordered
}
