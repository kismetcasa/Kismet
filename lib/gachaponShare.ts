import { KISMET_CHANNEL_KEY } from '@/lib/collectShare'
import { SITE_URL } from '@/lib/siteUrl'

/**
 * Sharing what came out of a gachapon — a capsule's prize, or a piece
 * collected from a reveal machine — to Farcaster.
 *
 * The copy is the product's: `just collected "Sunset" by @alice from the
 * Kismet Gachapon`. The artist goes by their Farcaster @handle, so the cast
 * mentions them; by their name when they have no Farcaster; and the "by" is
 * dropped rather than cast as a raw address (the ladder of
 * lib/collectShare.resolveCreatorHandle). The cast carries the artwork and
 * then the machine: the piece itself, and where to play for one.
 */
export function gachaponCastText(title: string | null, artistHandle: string | null): string {
  const subject = title?.trim() ? `"${title.trim()}"` : 'an artwork'
  return `just collected ${subject}${artistHandle ? ` by ${artistHandle}` : ''} from the Kismet Gachapon`
}

export interface GachaponShare {
  machineId: string
  collection: string
  tokenId: string
  title: string | null
  artist: string
}

export function gachaponShareEmbeds(s: GachaponShare): [string, string] {
  return [`${SITE_URL}/artwork/${s.collection.toLowerCase()}/${s.tokenId}`, `${SITE_URL}/play/${s.machineId}`]
}

/** Farcaster's web composer, for a share made outside a Mini App, posting to /kismet. */
export function gachaponComposeUrl(text: string, embeds: readonly string[]): string {
  const params = [`text=${encodeURIComponent(text)}`, ...embeds.map((e) => `embeds[]=${encodeURIComponent(e)}`), `channelKey=${KISMET_CHANNEL_KEY}`]
  return `https://farcaster.xyz/~/compose?${params.join('&')}`
}
