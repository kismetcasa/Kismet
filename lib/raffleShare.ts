// Post-entry follow/share config + copy for the raffle entry modal
// (components/RaffleEntryModal). Pure and client-safe.
//
// Artist resolution is two-tier (per product direction):
//   - Patron Collection → the artist the TOKEN's stored split pays
//     (patronTokenArtist), not the creator record, which is the platform
//     treasury on some Patron tokens. Each drop credits its own artist: token 1
//     Turro, token 3 Tornado Rodriguez, and a new drop its split's artist with
//     no code change. Curated handles from PATRON_ARTIST_OVERRIDES win where
//     the profile lacks them: "@turro" in casts, "Turro's (@MOTEMT3)" in tweets.
//   - Every other raffle → the artist resolved from the creator's profile.
// Both tiers use the same name ladder: FC @username preferred, display name
// otherwise, clause dropped when nothing better than a shortened address
// resolved (same ladder as lib/collectShare's resolveCreatorHandle).

import { isPatronCollection, patronTokenArtist } from './patronCollection'
import { SITE_URL } from './siteUrl'

/** Kismet's own accounts — the follow targets in the post-entry modal. */
export const KISMET_X_HANDLE = 'kismetdotart'
export const KISMET_FC_HANDLE = 'kismet'

export interface RaffleShareArtist {
  /** "@handle" (FC-verified) or a display name; null drops the artist clause. */
  fcLabel: string | null
  /** X copy label — "Turro's (@MOTEMT3)" when a Patron override curates an X
   *  handle, the plain "Name's" otherwise. */
  xLabel: string | null
  /** Kismet profile the modal links the artist name to. */
  profileAddress: string | null
  /** Display name for the modal message ("… us and Turro."). */
  displayName: string | null
}

const NO_ARTIST: RaffleShareArtist = {
  fcLabel: null,
  xLabel: null,
  profileAddress: null,
  displayName: null,
}

/**
 * The artist identity the modal + share copy should use. `profileAddress` is
 * whose profile to look up: the token's split artist for a Patron token, the
 * creator otherwise. `resolved*` come from the caller's fetchCreatorProfile
 * lookup of that address (fcUsername raw, name already fallback-laddered).
 *
 * Patron tokens need `splitRecipients`, the token's stored split as
 * /api/moment/splits returns it. Until it arrives (undefined), or when it
 * can't be read (null), the token's override alone carries the credit, so
 * token 1 names Turro on first paint and a token without an override names no
 * one rather than the wrong person.
 */
export function raffleShareArtist(opts: {
  collectionAddress: string
  tokenId: string
  creatorAddress?: string | null
  splitRecipients?: readonly { address: string; percentAllocation?: number }[] | null
  resolvedFcUsername?: string | null
  resolvedName?: string | null
}): RaffleShareArtist {
  const resolvedName = opts.resolvedName?.trim() || null
  const fc = opts.resolvedFcUsername?.trim() || null
  if (isPatronCollection(opts.collectionAddress)) {
    const credited = patronTokenArtist(opts.tokenId, opts.splitRecipients)
    if (!credited) return NO_ARTIST
    const o = credited.override
    const name = o?.name ?? resolvedName
    const xHandle = o?.xHandle
    return {
      fcLabel: o?.fcHandle ? `@${o.fcHandle}` : fc ? `@${fc}` : name,
      xLabel: xHandle ? (name ? `${name}'s (@${xHandle})` : `@${xHandle}'s`) : name ? `${name}'s` : null,
      profileAddress: credited.address,
      displayName: name,
    }
  }
  return {
    fcLabel: fc ? `@${fc}` : resolvedName,
    xLabel: resolvedName ? `${resolvedName}'s` : null,
    profileAddress: opts.creatorAddress ?? null,
    displayName: resolvedName,
  }
}

/** Farcaster cast text — "i just entered the raffle on @kismet to win
 *  @turro's physical artwork!" (artist clause adapts / drops per resolution). */
export function raffleCastText(artist: RaffleShareArtist): string {
  const win = artist.fcLabel ? `${artist.fcLabel}'s physical artwork` : 'this physical artwork'
  return `i just entered the raffle on @${KISMET_FC_HANDLE} to win ${win}!`
}

/** X post text — "i just entered the raffle on @kismetdotart to win
 *  Turro's (@MOTEMT3) physical artwork!" */
export function raffleTweetText(artist: RaffleShareArtist): string {
  const win = artist.xLabel ? `${artist.xLabel} physical artwork` : 'this physical artwork'
  return `i just entered the raffle on @${KISMET_X_HANDLE} to win ${win}!`
}

export const artworkShareUrl = (collectionAddress: string, tokenId: string) =>
  `${SITE_URL}/artwork/${collectionAddress.toLowerCase()}/${tokenId}`

/** Web (non-Mini-App) compose fallbacks + follow intents. */
export const xFollowUrl = `https://x.com/intent/follow?screen_name=${KISMET_X_HANDLE}`
export const fcFollowUrl = `https://farcaster.xyz/${KISMET_FC_HANDLE}`
export const xShareUrl = (text: string, url: string) =>
  `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
export const fcShareUrl = (text: string, embedUrl: string) =>
  `https://farcaster.xyz/~/compose?text=${encodeURIComponent(text)}&embeds[]=${encodeURIComponent(embedUrl)}`
