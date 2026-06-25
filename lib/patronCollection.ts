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

/** Turro's minting wallet — the artist chip links to this profile. */
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
export const PATRON_PASS_DESCRIPTION = `Turro’s artwork Facing Desolation marks the debut of the Kismet Patron Collection.
Each edition is 80 USD, calculated in ETH at the time of launch.

There will only ever be 100 editions available: 80 editions for public sale and up to 20 editions reserved for Turro to invite artists to the platform through airdrops.
At the end of the sale, any unsold editions will be burned and the associated physical artwork created by Turro will be gifted to one collector of the digital edition.`
