import { CREATE_REFERRAL, RESIDENCIES_ADDRESS } from './config'
import { PLATFORM_FEE_RECIPIENT } from './platformFee'

/**
 * Kismet Patron Collection — the first official platform release. Its
 * collection page gets a bespoke presentation instead of the generic grid
 * (see PatronArtworkShowcase + the CollectionView special-casing): each drop
 * as a full-bleed artwork with its own "Patron Pass Description" panel, and
 * an artist credit derived from each moment's on-chain split recipients —
 * the moment creator can resolve to the platform treasury (token 1's does),
 * so the split is the real attribution.
 * The page credit shows each artist's own resolved profile (no hardcoded
 * label). The raffle share credits each token's split artist the same way,
 * with curated handles from PATRON_ARTIST_OVERRIDES where the profile lacks
 * them; FeaturedMoment keeps its own "turro" credit for the Mint Pass Display.
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
 * The platform treasury (kismetart.eth; "Kismet Art" on In Process): the
 * Patron's on-chain default admin, the 80% payee on every Patron split (the
 * artist holds the other 20%), and the `creator` on some Patron records
 * (token 1's). Never an artist. It is also PLATFORM_FEE_RECIPIENT's default,
 * but that constant is env-overridable, so the treasury is pinned here: moving
 * the secondary-market fee to its own Safe must not turn the treasury into a
 * Patron "artist".
 */
export const PATRON_TREASURY = '0x099b9bbe0937428e145a3003ddf58e7e0cf69801'

/**
 * The split payees that are the platform, never the artist: the treasury
 * (pinned above, plus the configured fee recipient), referral, residencies,
 * and any collection roles the caller knows (the Patron page passes the
 * collection's default admin + payout recipient). One set behind every Patron
 * artist credit, the page's artist chips (CollectionView) and the per-token
 * raffle share (patronTokenArtist), so the two can't disagree about who the
 * artist is. Lowercased; empty entries dropped.
 */
export function patronPlatformPayees(...roles: (string | null | undefined)[]): Set<string> {
  return new Set(
    [PATRON_TREASURY, PLATFORM_FEE_RECIPIENT, CREATE_REFERRAL, RESIDENCIES_ADDRESS, ...roles]
      .filter((a): a is string => !!a)
      .map((a) => a.toLowerCase()),
  )
}

/**
 * Curated identity for one Patron token's artist, covering what their Kismet
 * profile can't supply. The raffle share reads it ahead of the profile lookup.
 *
 * A token needs NO entry to be credited correctly: its stored split names the
 * artist (patronTokenArtist) and their profile supplies the display name and
 * Farcaster handle. Add an entry only for what the profile lacks: an X handle
 * (profiles never supply one to the share copy), or a name / Farcaster handle
 * for an artist whose profile has none.
 *
 * Keyed by token id, and pinned to the artist `address` it was written for: it
 * applies only when the token's split pays that address (or when the split
 * can't be read at all), so a mis-keyed entry (the token-id trap
 * PATRON_PASS_INFO documents: token 2 is a hidden slot) can't put one artist's
 * handles on another artist's drop.
 */
export interface PatronArtistOverride {
  /** The artist's wallet, lowercased: the split payee this entry describes. */
  address: string
  /** Display name; wins over the profile's. */
  name?: string
  /** Farcaster handle, without the @. */
  fcHandle?: string
  /** X (Twitter) handle, without the @. */
  xHandle?: string
}

export const PATRON_ARTIST_OVERRIDES: Readonly<Record<string, PatronArtistOverride>> = {
  // Turro, "Facing Desolation". His wallet is the 20% payee on the token's
  // split. His profile is a bare username with no Farcaster or X, so all of
  // his handles are curated here.
  '1': {
    address: '0x6c1cbe8cfc32a74188a9d3bf364945ea53b01b04',
    name: 'Turro',
    fcHandle: 'turro',
    xHandle: 'MOTEMT3',
  },
  // Tornado Rodriguez, "Toxic Heritage: The Wounded Martyr's Trip". The
  // profile supplies his name and Farcaster handle (@tornado-); only the X
  // handle is curated (the X account verified on his Farcaster profile).
  '3': {
    address: '0x651d699af32cd71b5573571935c99c35f074dd51',
    xHandle: 'tornado_ilus',
  },
}

/**
 * Reduce per-moment split-recipient lists to a deduped, first-seen-ordered
 * list of artist addresses, dropping every address in `exclude` (the platform
 * treasury, residencies, referral, and the collection owner/payout; see
 * patronPlatformPayees). All addresses are lowercased. Attribution only:
 * `percentAllocation` is ignored.
 *
 * This is what makes the Patron page's artist credit data-driven: the moment
 * "creator" can resolve to the platform treasury, but the split names the real
 * artist(s), so future collaborators surface automatically. Collection-
 * agnostic by design; the Patron-specific wiring lives in CollectionView.
 */
export function deriveArtistsFromRecipients(
  recipientLists: readonly (readonly { address: string }[])[],
  exclude: ReadonlySet<string>,
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
 * The artist a Patron token credits, from its stored split (getStoredSplits,
 * which /api/moment/splits serves), with the platform payees excluded exactly
 * as the Patron page excludes them.
 *
 *   - The token's override wins when the split pays its artist (it is the
 *     curated pick between collaborators, and carries the curated handles).
 *   - Otherwise the split's artist is credited. If a drop ever splits between
 *     artists, the largest allocation wins, first-seen on a tie. An override
 *     naming someone the split doesn't pay is ignored: the split is the
 *     authority.
 *   - With no artist in the split (still loading, unreadable, a legacy record
 *     without recipients, or only platform payees) the override alone is the
 *     credit.
 *
 * null means nothing to credit. Callers drop the artist rather than fall back
 * to the creator record, which is the treasury on some Patron tokens.
 */
export function patronTokenArtist(
  tokenId: string,
  recipients: readonly { address: string; percentAllocation?: number }[] | null | undefined,
  exclude: ReadonlySet<string> = patronPlatformPayees(),
): { address: string; override: PatronArtistOverride | null } | null {
  // Own keys only: a non-numeric id ('constructor') must not read Object.prototype.
  const override = Object.prototype.hasOwnProperty.call(PATRON_ARTIST_OVERRIDES, tokenId)
    ? PATRON_ARTIST_OVERRIDES[tokenId]
    : null
  const pinned = override?.address.toLowerCase()
  const paid = recipients ?? []
  const artists = deriveArtistsFromRecipients([paid], exclude)
  if (override && pinned && (artists.length === 0 || artists.includes(pinned))) {
    return { address: pinned, override }
  }
  if (artists.length === 0) return null
  const share = (a: string) =>
    paid.reduce((sum, r) => (r.address.toLowerCase() === a ? sum + (r.percentAllocation ?? 0) : sum), 0)
  let primary = artists[0]
  for (const a of artists.slice(1)) if (share(a) > share(primary)) primary = a
  return { address: primary, override: null }
}

/**
 * Per-drop copy for the Patron Pass Description panels.
 *
 * Matching: a drop's panel attaches to the moment whose token id equals the
 * entry's `tokenId` (when pinned) OR whose metadata name contains any of its
 * `titleMatch` substrings (lowercased containment). Title is the durable key
 * here: the collection's token ids are NOT contiguous — token 2 is a hidden
 * slot, so the Tornado drop is token 3 — which is what silently broke the
 * original id-keyed map (it assumed Tornado = 2). The artwork's title is
 * what the curator writing this copy always knows; `tokenId` pins ids
 * confirmed in production (Turro 1, Tornado 3). Keep `titleMatch`
 * distinctive per entry; first match wins.
 *
 * A moment matching no entry renders no panel — add an entry when a new
 * drop is prepared, and it attaches the moment the mint lands. `description`
 * renders with `whitespace-pre-line` (line breaks preserved verbatim); the
 * first "Kismet Casa" occurrence, when present, is linkified by the panel.
 *
 * `saleEnded: true` freezes the panel's CTA as a disabled "sale ended" in
 * place of the live collect button — for drops whose mint is permanently
 * closed (Patron sale windows are one-shot, per the copy). Deliberately
 * static: it also skips the on-chain supply/sale reads a live button would
 * mount for a sale that can never reopen.
 */
export interface PatronPassInfo {
  /** Exact token id, when proven in production. Pin only, never required. */
  tokenId?: string
  /** Lowercase substrings; any hit on the moment's metadata name matches. */
  titleMatch: string[]
  description: string
  saleEnded?: boolean
}

export const PATRON_PASS_INFO: PatronPassInfo[] = [
  // Turro — "Facing Desolation" (debut drop, token 1; mint closed).
  {
    tokenId: '1',
    titleMatch: ['facing desolation'],
    description: `Turro’s artwork Facing Desolation marked the debut of the Kismet Patron Collection. It is a physical work commissioned by Kismet Casa and gifted to one collector of the digital edition.

A total of 19 editions were minted: 15 were collected during the public sale, while 4 were used by Turro to invite other artists to the platform. The mint is now closed.`,
    saleEnded: true,
  },
  // Tornado — "Toxic Heritage: The Wounded Martyr’s Trip" (second drop;
  // token 3, the collection's third mint — token 2 is a hidden slot). Title
  // match kept as the secondary key; either half of the long title hits.
  {
    tokenId: '3',
    titleMatch: ['toxic heritage', 'wounded martyr'],
    description: `Toxic Heritage: The Wounded Martyr’s Trip by Tornado marks the second drop in the Kismet Patron Collection.

There are only 100 editions available to collect. At the end of the sale, any remaining editions will be permanently unavailable to mint.`,
  },
]

/**
 * Resolve the curated pass copy for a Patron moment — token-id pin first,
 * then title containment — or undefined when the drop has no entry (the
 * panel then renders nothing).
 */
export function patronPassInfoFor(
  tokenId: string,
  name?: string,
): PatronPassInfo | undefined {
  const lower = (name ?? '').toLowerCase()
  return PATRON_PASS_INFO.find(
    (e) => (e.tokenId !== undefined && e.tokenId === tokenId) || e.titleMatch.some((m) => lower.includes(m)),
  )
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
