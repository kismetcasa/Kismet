// Publish-time invariants for a machine. PURE — every input is passed in, so
// the oracle can execute all of it and so the same function guards both the
// creator-facing "can I publish?" preview and the server-side publish route.
//
// The central obligation this file enforces: EVERY CAPSULE SOLD MUST BE
// HONOURABLE. A capsule is a claim on the pool, and the two things that can
// break that claim are capped pieces running out and artists revoking their
// grant — the second of which we deliberately keep possible, because revocable
// consent is the whole ethics of the pool. So solvency is not a promise, it is
// a structural bound plus a floor.

import {
  MAX_POOL_ARTISTS,
  MAX_POOL_ENTRIES,
  MAX_WEIGHT,
  entryKey,
  poolArtists,
} from './draw'
import type { PoolEntry } from './types'

export interface SolvencyInput {
  /** Immutable on-chain ceiling on how many capsules can ever exist. null =
   *  the capsule is an open edition, which can never be solvent against capped
   *  prizes alone and therefore REQUIRES a floor piece. */
  capsuleMaxSupply: number | null
  /** How many capsules have already been minted (sold). */
  capsuleMinted: number
  entries: PoolEntry[]
  /** Lowercased addresses in the machine's split. Every pool artist must be here. */
  splitRecipients: string[]
  /** Lowercased machine creator. The floor piece must be theirs — it is the
   *  guarantee they personally stand behind, not one they can borrow from an
   *  artist who may walk away. */
  creator: string
  /** The gate's configured Pass collection, lowercased, or null when the gate
   *  is unconfigured. See `passCollection` below for why this is fatal. */
  passCollection: string | null
  /** Live on-chain headroom per entry key: maxSupply − totalMinted, or null for
   *  an open edition. An entry pledging more than its headroom is unfulfillable. */
  headroom: Record<string, number | null>
  /** Supply already pledged for each entry key by OTHER machines. The
   *  cross-machine commitment ledger — without it two hosts can promise the same
   *  last edition and only one of them can be right. */
  otherPledges: Record<string, number>
}

export type SolvencyProblem =
  | { code: 'empty-pool'; detail: string }
  | { code: 'too-many-entries'; detail: string }
  | { code: 'too-many-artists'; detail: string }
  | { code: 'bad-weight'; detail: string }
  | { code: 'bad-supply'; detail: string }
  | { code: 'duplicate-entry'; detail: string }
  | { code: 'artist-not-in-split'; detail: string }
  | { code: 'pass-collection'; detail: string }
  | { code: 'over-headroom'; detail: string }
  | { code: 'undercollateralised'; detail: string }
  | { code: 'floor-not-creator'; detail: string }

/** Total copies the pool can release. null = unbounded (a floor piece exists). */
export function pledgedSupply(entries: PoolEntry[]): number | null {
  let sum = 0
  for (const e of entries) {
    if (e.supply === 0) return null
    sum += e.supply
  }
  return sum
}

/** An open-supply entry owned by the machine's creator: the guarantee that any
 *  capsule can always be honoured no matter who else withdraws. */
export function findFloorPiece(
  entries: PoolEntry[],
  creator: string,
): PoolEntry | undefined {
  const c = creator.toLowerCase()
  return entries.find((e) => e.supply === 0 && e.artist.toLowerCase() === c)
}

/**
 * Every publish-time check, in one place. Returns ALL problems rather than the
 * first, so a creator fixing a machine sees the whole list instead of
 * discovering them one submit at a time.
 */
export function checkSolvency(input: SolvencyInput): SolvencyProblem[] {
  const problems: SolvencyProblem[] = []
  const { entries, creator, passCollection } = input

  if (entries.length === 0) {
    problems.push({ code: 'empty-pool', detail: 'a machine needs at least one artwork' })
    return problems
  }
  if (entries.length > MAX_POOL_ENTRIES) {
    problems.push({
      code: 'too-many-entries',
      detail: `${entries.length} artworks exceeds the ${MAX_POOL_ENTRIES} limit`,
    })
  }

  const artists = poolArtists(entries)
  if (artists.length > MAX_POOL_ARTISTS) {
    // Bounded by the split cap, not by taste: an artist who cannot be a split
    // recipient cannot be paid, and an unpaid contributor must not be drawable.
    problems.push({
      code: 'too-many-artists',
      detail: `${artists.length} artists exceeds the ${MAX_POOL_ARTISTS} limit (the split cap)`,
    })
  }

  const seen = new Set<string>()
  const splits = new Set(input.splitRecipients.map((a) => a.toLowerCase()))

  for (const e of entries) {
    const key = entryKey(e)

    if (seen.has(key)) {
      problems.push({ code: 'duplicate-entry', detail: `${key} appears twice` })
      continue
    }
    seen.add(key)

    if (!Number.isInteger(e.weight) || e.weight <= 0 || e.weight > MAX_WEIGHT) {
      problems.push({ code: 'bad-weight', detail: `${key} has weight ${e.weight}` })
    }
    if (!Number.isInteger(e.supply) || e.supply < 0) {
      problems.push({ code: 'bad-supply', detail: `${key} has supply ${e.supply}` })
    }

    if (!splits.has(e.artist.toLowerCase())) {
      // No uncompensated contributors. An artist granted mint rights and must
      // share the machine's revenue; a pool entry whose artist is absent from
      // the split is a machine giving away someone's work for free.
      problems.push({
        code: 'artist-not-in-split',
        detail: `${e.artist} contributes ${key} but is not in the split`,
      })
    }

    if (passCollection && e.collection.toLowerCase() === passCollection) {
      // THE HAZARD THIS FILE EXISTS TO BLOCK. Prize delivery is `adminMint`,
      // which emits TransferSingle(0x0 -> player) — byte-identical to a
      // purchased Pass mint. lib/pass-validity.processTransfer credits validity
      // on ANY mint (`if (platform || isMint)`), deliberately, so a dropped
      // /api/collect can't lose a buyer's credit. A Pass-collection artwork in a
      // pool would therefore turn a machine into a creator-credential vending
      // machine — precisely the laundering the gate exists to prevent.
      //
      // Checked here AND re-checked at freeze, because the gate's
      // passCollection is a runtime Redis value that can change after an entry
      // was admitted.
      problems.push({
        code: 'pass-collection',
        detail: `${key} is in the Pass collection and can never be a prize`,
      })
    }

    const head = input.headroom[key]
    if (head !== undefined && head !== null) {
      const others = input.otherPledges[key] ?? 0
      const need = e.supply === 0 ? Infinity : e.supply
      if (need + others > head) {
        problems.push({
          code: 'over-headroom',
          detail:
            e.supply === 0
              ? `${key} is a capped edition and cannot back an unlimited pledge`
              : `${key} pledges ${e.supply} but only ${head - others} remain after other machines`,
        })
      }
    }
  }

  // The solvency bound itself.
  //
  // A creator-owned unlimited entry (the floor) discharges the obligation
  // outright: whatever else happens — every other artist revoking, every capped
  // edition exhausting — a capsule can still be honoured by a piece the machine's
  // own creator stands behind.
  //
  // An unlimited entry belonging to SOMEONE ELSE deliberately does NOT count.
  // It can supply copies only while that artist's grant holds, and revocability
  // is a property we keep on purpose, so borrowing a stranger's open edition as
  // your solvency guarantee is exactly the promise we must not let a creator
  // make. Coverage must therefore come from capped pledges, or from the
  // creator's own floor.
  const creatorFloor = findFloorPiece(entries, creator)
  const foreignOpen = entries.find(
    (e) => e.supply === 0 && e.artist.toLowerCase() !== creator.toLowerCase(),
  )
  const outstanding = input.capsuleMaxSupply

  if (!creatorFloor) {
    // Capped pledges only — a foreign open edition contributes nothing provable.
    const cappedPledged = entries.reduce((sum, e) => (e.supply > 0 ? sum + e.supply : sum), 0)
    const shortfall = outstanding === null || outstanding > cappedPledged

    if (shortfall) {
      problems.push({
        code: 'undercollateralised',
        detail:
          outstanding === null
            ? 'an open-edition capsule needs an unlimited artwork by the creator to back it'
            : `${outstanding} capsules can be sold but only ${cappedPledged} artworks are guaranteed`,
      })
      if (foreignOpen) {
        // Only reported when the machine is actually LEANING on it. A foreign
        // open edition alongside fully-covering capped pledges is a bonus, not a
        // fault, and blocking that would reject a perfectly solvent machine.
        problems.push({
          code: 'floor-not-creator',
          detail: `the unlimited artwork backing this machine belongs to ${foreignOpen.artist}, not its creator — add one of your own`,
        })
      }
    }
  }

  return problems
}

/** Live coverage, rendered publicly on the machine page: how many prizes remain
 *  against how many capsules could still be sold. `null` = unbounded (a floor
 *  piece exists), which displays as "always available" rather than a ratio. */
export function coverage(input: {
  capsuleMaxSupply: number | null
  capsuleMinted: number
  remainingPrizes: number | null
}): { capsulesOutstanding: number | null; prizesRemaining: number | null; covered: boolean } {
  const outstanding =
    input.capsuleMaxSupply === null
      ? null
      : Math.max(0, input.capsuleMaxSupply - input.capsuleMinted)
  if (input.remainingPrizes === null) {
    return { capsulesOutstanding: outstanding, prizesRemaining: null, covered: true }
  }
  if (outstanding === null) {
    return { capsulesOutstanding: null, prizesRemaining: input.remainingPrizes, covered: false }
  }
  return {
    capsulesOutstanding: outstanding,
    prizesRemaining: input.remainingPrizes,
    covered: input.remainingPrizes >= outstanding,
  }
}
