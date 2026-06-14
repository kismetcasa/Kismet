/**
 * Fair allocation of a single drop's supply across the users whose agents want it
 * (Phase 3 — coordinated collecting). When a watched artist drops, many agents
 * want the same token at once; a naive first-come loop lets the earliest/loudest
 * grab everything. Instead we allocate ROUND-ROBIN: everyone gets 1, then a 2nd,
 * … until the supply runs out or everyone is at their per-drop target (or budget).
 *
 * Worked example (the product spec): a 100-edition drop, 100 watchers each set to
 * "up to 10 per drop" → round 1 hands out 1 to each of the 100, supply is gone,
 * every watcher gets exactly 1. (20 watchers wanting 10 of a 100-drop → 5 each.)
 *
 * Pure + deterministic given the input order, so it's unit-verifiable. The
 * coordinator pre-orders `watchers` fairly (rotating by the drop, so the same
 * users aren't always first) and computes each one's affordable cap; this only
 * does the division.
 */

export interface DropWatcher {
  /** The watching user's Base Account (lowercased). */
  owner: string
  /** Editions they want of this drop: 1 (Patron) or N (Editions mode). >= 0. */
  target: number
  /** Hard ceiling from their budget + per-wallet cap (editions they can actually
   *  take). The allocation never exceeds min(target, affordable). >= 0. */
  affordable: number
}

export interface DropAllocation {
  owner: string
  /** Editions to mint for this owner (>= 1; owners allocated 0 are omitted). */
  editions: number
}

/** ERC-1155 open editions have no fixed cap; the coordinator passes this so the
 *  round-robin is bounded only by each watcher's target/affordable, not supply. */
export const OPEN_EDITION_SUPPLY = Number.MAX_SAFE_INTEGER

/**
 * Allocate `supply` editions across `watchers` (already in the fair iteration
 * order) round-robin. Each pass gives one more edition to every watcher still
 * under their min(target, affordable), until supply is exhausted or no watcher
 * can take more. Returns only owners that got >= 1.
 */
export function allocateRoundRobin(
  watchers: readonly DropWatcher[],
  supply: number,
): DropAllocation[] {
  const alloc = new Map<string, number>()
  let remaining = Math.max(0, Math.floor(supply))

  let progressed = true
  while (remaining > 0 && progressed) {
    progressed = false
    for (const w of watchers) {
      if (remaining <= 0) break
      const cap = Math.max(0, Math.min(Math.floor(w.target), Math.floor(w.affordable)))
      const current = alloc.get(w.owner) ?? 0
      if (current < cap) {
        alloc.set(w.owner, current + 1)
        remaining -= 1
        progressed = true
      }
    }
  }

  const out: DropAllocation[] = []
  for (const [owner, editions] of alloc) if (editions > 0) out.push({ owner, editions })
  return out
}

/**
 * Deterministic fair ordering for a drop: rotate the watchers by a seed derived
 * from the drop id, so allocation order varies drop-to-drop (the same users
 * aren't perpetually first when supply is scarce) yet is reproducible for a given
 * drop. Stable starting order in, rotated order out.
 */
export function fairOrder<T>(items: readonly T[], seed: string): T[] {
  const n = items.length
  if (n <= 1) return [...items]
  let h = 2166136261 >>> 0 // FNV-1a
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  const start = h % n
  return [...items.slice(start), ...items.slice(0, start)]
}
