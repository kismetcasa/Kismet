// Kismet Patron Collection — the first official token-gate collection.
// Holding a valid edition from this collection unlocks minting access
// (see lib/gate.ts + hooks/usePassGate). This module is the single source of
// truth for the collection address and the editorial copy rendered on the
// /patron page (components/PatronCollection) and its "Mint Access Rules"
// modal (components/MintAccessRulesModal). Keeping all of it here means the
// final copy can be edited in one place without touching component logic.

/** The Patron Collection contract on Base (checksummed). */
export const PATRON_COLLECTION_ADDRESS =
  '0x80Ce7bD430F34792490a22ee0Fd479E7333715C9'

/** Lowercase form for address comparisons (the gate config stores lowercase). */
export const PATRON_COLLECTION_ADDRESS_LOWER =
  PATRON_COLLECTION_ADDRESS.toLowerCase()

/** Hero copy at the top of the /patron page. */
export const PATRON_TITLE = 'Kismet Patron Collection'
export const PATRON_TAGLINE =
  'Collect an artwork from the Kismet Patron Collection to unlock minting access.'

/**
 * Per-artwork descriptions rendered beneath each big horizontal display,
 * keyed by tokenId. Placeholder map — drop the final text per piece in here.
 * A tokenId with no entry falls back to the moment's own on-chain
 * metadata.description, so the page is never blank before copy lands.
 */
export const PATRON_ARTWORK_DESCRIPTIONS: Record<string, string> = {
  // Example — replace with the final copy and the real tokenId:
  // '1': 'Facing Desolation — <final description to be provided>',
}

/** A heading + one or more paragraphs in the Mint Access Rules modal. */
export interface RuleSection {
  heading?: string
  paragraphs: string[]
}

/**
 * "Mint Access Rules" modal content. Seeded from the launch brief so the modal
 * is meaningful out of the box; edit the sections below with the final text.
 */
export const MINT_ACCESS_RULES: { title: string; sections: RuleSection[] } = {
  title: 'Mint Access Rules',
  sections: [
    {
      heading: 'The collection',
      paragraphs: [
        "Turro's artwork Facing Desolation marks the debut of the Kismet Patron Collection. Each edition is 80 USD, calculated in ETH at the time of launch.",
      ],
    },
    {
      heading: 'Supply',
      paragraphs: [
        'There will only ever be 100 editions available: 80 editions for public sale and up to 20 editions reserved for Turro to invite artists to the platform through airdrops.',
      ],
    },
    {
      heading: 'End of sale',
      paragraphs: [
        'At the end of the sale, any unsold editions will be burned and the associated physical artwork created by Turro will be gifted to one collector of the digital edition through a raffle.',
      ],
    },
    {
      heading: 'Unlocking minting',
      paragraphs: [
        'Collect an artwork from the Kismet Patron Collection to unlock minting access across the platform.',
      ],
    },
  ],
}
