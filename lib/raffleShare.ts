// Post-entry follow/share config + copy for the raffle entry modal
// (components/RaffleEntryModal). Pure and client-safe.
//
// Artist resolution is two-tier (per product direction):
//   - Patron Collection → the curated PATRON_ARTIST (Turro): the moment
//     records' creator resolves to the platform treasury, so the copy names
//     Turro explicitly — "@turro" in casts, "Turro's (@MOTEMT3)" in tweets.
//   - Every other raffle → the artist resolved from the creator's profile
//     (FC @username preferred, display name otherwise, clause dropped when
//     nothing better than a shortened address resolved — same ladder as
//     lib/collectShare's resolveCreatorHandle).

import { isPatronCollection, PATRON_ARTIST } from './patronCollection'
import { SITE_URL } from './siteUrl'

/** Kismet's own accounts — the follow targets in the post-entry modal. */
export const KISMET_X_HANDLE = 'kismetdotart'
export const KISMET_FC_HANDLE = 'kismet'

export interface RaffleShareArtist {
  /** "@handle" (FC-verified) or a display name; null drops the artist clause. */
  fcLabel: string | null
  /** X copy label — "Turro's (@MOTEMT3)" for Patron, a plain name otherwise. */
  xLabel: string | null
  /** Kismet profile the modal links the artist name to. */
  profileAddress: string | null
  /** Display name for the modal message ("… us and Turro."). */
  displayName: string | null
}

/**
 * The artist identity the modal + share copy should use. `resolved*` come
 * from the caller's fetchCreatorProfile lookup (fcUsername raw, name already
 * fallback-laddered) and are ignored for Patron artworks.
 */
export function raffleShareArtist(opts: {
  collectionAddress: string
  creatorAddress?: string | null
  resolvedFcUsername?: string | null
  resolvedName?: string | null
}): RaffleShareArtist {
  if (isPatronCollection(opts.collectionAddress)) {
    return {
      fcLabel: `@${PATRON_ARTIST.fcHandle}`,
      xLabel: `${PATRON_ARTIST.name}'s (@${PATRON_ARTIST.xHandle})`,
      profileAddress: PATRON_ARTIST.address,
      displayName: PATRON_ARTIST.name,
    }
  }
  const name = opts.resolvedName?.trim() || null
  const fc = opts.resolvedFcUsername?.trim() || null
  return {
    fcLabel: fc ? `@${fc}` : name,
    xLabel: name ? `${name}'s` : null,
    profileAddress: opts.creatorAddress ?? null,
    displayName: name,
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
