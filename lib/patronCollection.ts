/**
 * Kismet Patron Collection — the first official platform release. Its
 * collection page gets a bespoke presentation instead of the generic
 * grid (see PatronArtworkShowcase + the CollectionView special-casing):
 * a single full-bleed artwork followed by a "Patron Pass Description"
 * panel, with the artwork credited to Turro regardless of the on-chain
 * minter wallet — that wallet has no Kismet username / primary ENS set,
 * the same stopgap FeaturedMoment's CREDIT_OVERRIDES covers for the
 * featured Mint Pass Display.
 *
 * Address comparisons are lowercase; both constants are stored lowercased
 * so callers can compare against `address.toLowerCase()` directly.
 */
export const PATRON_COLLECTION_ADDRESS =
  '0x80ce7bd430f34792490a22ee0fd479e7333715c9'

/**
 * On-chain creator/payout address behind the Patron artwork — in practice the
 * Kismet platform treasury (PLATFORM_FEE_RECIPIENT), which resolves to the
 * kismetart.eth profile. "turro" is a curated display credit over it (the same
 * stopgap FeaturedMoment's CREDIT_OVERRIDES applies), so the artist chip is
 * rendered NON-clickable rather than linking here and sending visitors to the
 * treasury's profile. Used only to seed the chip's avatar gradient.
 */
export const PATRON_ARTIST_ADDRESS =
  '0x099b9bbe0937428e145a3003ddf58e7e0cf69801'

/** Display credit for the artist, shown verbatim. */
export const PATRON_ARTIST_LABEL = 'turro'

export function isPatronCollection(address?: string | null): boolean {
  return !!address && address.toLowerCase() === PATRON_COLLECTION_ADDRESS
}

/**
 * Body copy for the Patron Pass Description panel. Rendered with
 * `whitespace-pre-line`, so the line breaks below are preserved verbatim.
 */
export const PATRON_PASS_DESCRIPTION = `Turro’s artwork Facing Desolation marks the debut of the Kismet Patron Collection. Kismet commissioned a physical artwork that represents the collection which will be gifted to one collector of the digital work.

There will only ever be 100 editions available: 80 editions for public sale and up to 20 editions reserved for Turro to invite artists to the platform. At the end of the sale, any unsold editions will be unavailable to mint.`
