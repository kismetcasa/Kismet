// The artist credit on the Mint Pass Display hero (components/FeaturedMoment):
// who the "by …" line names and whose profile it links. Pure and client-safe,
// so scripts/verify-featured-credit.ts checks the exact choice the hero renders.
//
// Who is credited:
//   - Patron Collection → the artist the TOKEN's stored split pays
//     (patronTokenArtist), the resolver behind the raffle share and the Patron
//     page's artist chips, so the three name the same artist. Never the
//     creator record: it is the platform treasury on some Patron tokens (token
//     1's). With no artist in the split and no override, nobody is credited.
//   - Every other collection → the creator record (/api/moment's KV-corrected
//     minter EOA), whoever that is. A treasury mint outside the Patron credits
//     the treasury, as every other surface does; no address maps to an artist.

import { shortAddress } from './inprocess'
import { isPatronCollection, patronTokenArtist } from './patronCollection'

export interface FeaturedCredit {
  /** The credited wallet. The byline links its profile. */
  address: string
  /** A curated display name (a Patron override). Shown verbatim, and the
   *  hero skips the profile lookup for it. */
  name: string | null
}

export function featuredCredit(opts: {
  collectionAddress: string
  tokenId: string
  /** The record's creator (/api/moment's `creator.address`). */
  creatorAddress?: string | null
  /** Patron only: the token's stored split, as /api/moment/splits returns it.
   *  undefined while it loads, null when it can't be read. Either way the
   *  token's override alone carries the credit until the split says otherwise. */
  splitRecipients?: readonly { address: string; percentAllocation?: number }[] | null
}): FeaturedCredit | null {
  if (isPatronCollection(opts.collectionAddress)) {
    const credited = patronTokenArtist(opts.tokenId, opts.splitRecipients)
    return credited ? { address: credited.address, name: credited.override?.name ?? null } : null
  }
  return opts.creatorAddress ? { address: opts.creatorAddress, name: null } : null
}

/**
 * The hero's "by …" line for a credit. Label ladder: the curated name
 * verbatim ("Turro"); else the credited wallet's resolved profile name as
 * "@name"; else the record's username, when the credit is the record's
 * creator; else the short address. A lookup that only found the
 * short-address placeholder never replaces a better label, and a lookup for
 * another wallet (an earlier credit the split corrected) is ignored.
 */
export function featuredByline(
  credit: FeaturedCredit,
  opts: {
    creatorAddress?: string | null
    creatorUsername?: string | null
    /** The latest fetchCreatorProfile result, tagged with the wallet looked up. */
    profile?: { address: string; name: string } | null
  } = {},
): { href: string; label: string } {
  const href = `/profile/${credit.address}`
  if (credit.name) return { href, label: credit.name }
  const placeholder = shortAddress(credit.address)
  const forCredit = opts.profile?.address.toLowerCase() === credit.address.toLowerCase()
  // Case-insensitive: the profile cache builds its placeholder from whichever
  // casing first looked the address up.
  const resolved = forCredit ? opts.profile?.name.trim() : undefined
  if (resolved && resolved.toLowerCase() !== placeholder.toLowerCase()) return { href, label: `@${resolved}` }
  const username = opts.creatorUsername?.trim()
  const isCreator = opts.creatorAddress?.toLowerCase() === credit.address.toLowerCase()
  if (username && isCreator) return { href, label: `@${username}` }
  return { href, label: placeholder }
}
