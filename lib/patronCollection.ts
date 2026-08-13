/**
 * Kismet Patron Collection — the first official platform release. Its
 * collection page gets a bespoke presentation instead of the generic grid
 * (see PatronArtworkShowcase + the CollectionView special-casing): each drop
 * as a full-bleed artwork with its own "Patron Pass Description" panel, and
 * an artist credit derived from each moment's on-chain split recipients —
 * the moment creator resolves to the platform treasury, so the split is the
 * real attribution.
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
 * Turro — the Patron Collection's debut artist. The moment records' `creator`
 * resolves to the platform treasury, so Patron raffle surfaces (the
 * post-entry modal + share copy) name Turro from this curated config instead
 * of the creator record. Address matches the FeaturedMoment display override.
 * Collection-scoped, not per-token: if a raffle is ever run for a later drop
 * (Tornado onward), this config needs to graduate to a per-token map first.
 */
export const PATRON_ARTIST = {
  name: 'Turro',
  address: '0x099b9bbe0937428e145a3003ddf58e7e0cf69801',
  /** Farcaster handle, without the @. */
  fcHandle: 'turro',
  /** X (Twitter) handle, without the @. */
  xHandle: 'MOTEMT3',
} as const

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
 * Per-drop copy for the Patron Pass Description panels, keyed by token id
 * within the Patron collection (Zora 1155 ids are sequential from 1; each
 * curated drop takes the next id). A token with no entry renders no panel —
 * add the copy here when a new drop is prepared, so it attaches the moment
 * the mint lands. Rendered with `whitespace-pre-line` (line breaks preserved
 * verbatim); the first "Kismet Casa" occurrence, when present, is linkified
 * by the panel.
 *
 * `saleEnded: true` freezes the panel's CTA as a disabled "sale ended" in
 * place of the live collect button — for drops whose mint is permanently
 * closed (Patron sale windows are one-shot, per the copy). Deliberately
 * static: it also skips the on-chain supply/sale reads a live button would
 * mount for a sale that can never reopen.
 */
export interface PatronPassInfo {
  description: string
  saleEnded?: boolean
}

export const PATRON_PASS_INFO: Record<string, PatronPassInfo> = {
  // Token 1 — Turro, "Facing Desolation" (debut drop; mint closed).
  '1': {
    description: `Turro’s artwork Facing Desolation marked the debut of the Kismet Patron Collection. It is a physical work commissioned by Kismet Casa and gifted to one collector of the digital edition.

A total of 19 editions were minted: 15 were collected during the public sale, while 4 were used by Turro to invite other artists to the platform. The mint is now closed.`,
    saleEnded: true,
  },
  // Token 2 — Tornado, "Toxic Heritage: The Wounded Martyr’s Trip" (second drop).
  '2': {
    description: `Toxic Heritage: The Wounded Martyr’s Trip by Tornado marks the second drop in the Kismet Patron Collection.

There are only 100 editions available to collect. At the end of the sale, any remaining editions will be permanently unavailable to mint.`,
  },
}

/**
 * Content for the "Mint Pass Ruleset" modal, surfaced from the Patron
 * Collection page's Information button. Structured (not a flat string) so the
 * modal can render each section with its own tone/icon and the copy stays in
 * one place. `tone` drives the section's accent in PatronInfoModal.
 */
export const PATRON_MINT_PASS_RULESET = {
  title: 'Mint Pass Ruleset',
  notice: 'Always make sure you are on Kismet.art before purchasing a Mint Pass.',
  sections: [
    {
      tone: 'valid' as const,
      heading: 'Valid for minting',
      items: [
        'Receive an airdrop of the artwork.',
        'Mint the artwork on Kismet.',
        'Purchase the artwork on the Kismet secondary market.',
      ],
    },
    {
      tone: 'invalid' as const,
      heading: 'Invalid for minting',
      items: [
        'Transfer the artwork to another wallet.',
        'Sell the artwork outside the platform.',
      ],
    },
    {
      tone: 'contact' as const,
      heading: 'Contact us if',
      items: [
        'You lose access to the wallet holding the artwork.',
        'You encounter an issue minting with a valid NFT.',
        'You are unable to perform an airdrop after being authorized.',
      ],
    },
  ],
} as const

export type PatronRulesetTone =
  (typeof PATRON_MINT_PASS_RULESET)['sections'][number]['tone']
