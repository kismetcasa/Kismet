/**
 * Kismet Patron Collection — the first official platform release. Its
 * collection page gets a bespoke presentation instead of the generic grid
 * (see PatronArtworkShowcase + the CollectionView special-casing): a single
 * full-bleed artwork, a "Patron Pass Description" panel, and an artist credit
 * derived from each moment's on-chain split recipients — the moment creator
 * resolves to the platform treasury, so the split is the real attribution.
 * The credit shows each artist's own resolved profile (no hardcoded label);
 * the only curated "turro" override lives in FeaturedMoment for the featured
 * Mint Pass Display.
 *
 * Address stored lowercased so callers can compare against
 * `address.toLowerCase()` directly.
 */
export const PATRON_COLLECTION_ADDRESS =
  '0x80ce7bd430f34792490a22ee0fd479e7333715c9'

export function isPatronCollection(address?: string | null): boolean {
  return !!address && address.toLowerCase() === PATRON_COLLECTION_ADDRESS
}

/**
 * Reduce per-moment split-recipient lists to a deduped, first-seen-ordered
 * list of artist addresses, dropping every address in `exclude` (the platform
 * treasury, residencies, referral, and the collection owner/payout). All
 * addresses are lowercased. Attribution only — `percentAllocation` is ignored.
 *
 * This is what makes the Patron page's artist credit data-driven: the moment
 * "creator" resolves to the platform treasury, but the split names the real
 * artist(s), so future collaborators surface automatically. Collection-
 * agnostic by design; the Patron-specific wiring lives in CollectionView.
 */
export function deriveArtistsFromRecipients(
  recipientLists: { address: string }[][],
  exclude: Set<string>,
): string[] {
  const out: string[] = []
  for (const list of recipientLists) {
    for (const r of list) {
      const a = r.address.toLowerCase()
      if (!exclude.has(a) && !out.includes(a)) out.push(a)
    }
  }
  return out
}

/**
 * Body copy for the Patron Pass Description panel. Rendered with
 * `whitespace-pre-line`, so the line breaks below are preserved verbatim.
 */
export const PATRON_PASS_DESCRIPTION = `Turro’s artwork "Facing Desolation" marks the debut of the Kismet Patron Collection. Facing Desolation is a physical Artwork commissioned by Kismet Casa (kismetcasa.xyz) to gift to one collector of the digital edition.

There will only ever be 100 editions available of which up to 20 are reserved for Turro to invite artists to the platform. At the end of the sale, any remaining editions will be permanently unavailable to mint.`
