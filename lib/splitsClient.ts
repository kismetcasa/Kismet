// Browser read of one token's stored split: /api/moment/splits, which serves
// getStoredSplits (lib/splits). Relative URL, so client-only. The per-token
// Patron credits (the raffle share in RaffleEntryModal, the Mint Pass Display
// hero in FeaturedMoment) both read through this, so patronTokenArtist always
// gets the same input and the two can't credit different artists.

import { isAddress } from './address'
import type { SplitRecipient } from './splits'

/**
 * The token's split recipients: [] when the record stores none (no split, or
 * a legacy flag-only record), null when the split can't be read. Entries
 * without a valid address are dropped.
 */
export function fetchSplitRecipients(collectionAddress: string, tokenId: string): Promise<SplitRecipient[] | null> {
  return fetch(`/api/moment/splits?${new URLSearchParams({ collectionAddress, tokenId })}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { recipients?: unknown } | null) =>
      Array.isArray(d?.recipients)
        ? (d.recipients as SplitRecipient[]).filter((r) => isAddress(r?.address))
        : null,
    )
    .catch(() => null)
}
