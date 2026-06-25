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
 * Turro's Kismet profile address — the artist chip links here and seeds its
 * avatar. Distinct from the artwork's on-chain creator/payout, which is the
 * Kismet platform treasury (it resolves to the kismetart.eth profile); "turro"
 * is a curated display credit, so we link the real profile rather than the
 * treasury the moments resolve to.
 */
export const PATRON_ARTIST_ADDRESS =
  '0x6c1cbe8cfc32a74188a9d3bf364945ea53b01b04'

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
