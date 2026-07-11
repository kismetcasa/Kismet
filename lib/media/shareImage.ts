import { resolveUri } from '@/lib/inprocess'
import { isSafePublicHttpsUrl } from '@/lib/safeUrl'

/**
 * Resolve a moment/collection `meta.image` to a gateway URL for the OG
 * share-card routes (app/**\/opengraph-image.tsx), which feed it to Satori's
 * <img>. Satori rasterizes whatever it fetches into the bounded 1200x800
 * card PNG, so this is the right sink for heavy originals — unlike a raw
 * crawler tag (X drops images >5MB) or the next/image optimizer (413's on
 * sources past its 50MB body cap; see MomentImage's proxy mode). Three
 * guard rails:
 *
 *   1. Skip when no image is set — the card falls back to the branded
 *      text-only layout rather than rendering a broken <img>.
 *   2. Skip when the image equals the moment's animation_url — legacy
 *      MintForm bug wrote the video URL into meta.image, so the card
 *      would try to rasterize a multi-MB MP4 and fail.
 *   3. Skip `data:` URIs — Satori can't reliably embed them at this
 *      scale (text-mint auto-deploy stores SVG data URIs as covers).
 *
 * Resolves ar:// / ipfs:// to the canonical gateway URL and SSRF-guards
 * the host (this URL is fetched server-side during the OG render).
 */
export function shareImageUrl(
  imageUri: string | undefined,
  guardAgainst?: string,
): string | undefined {
  if (!imageUri) return undefined
  if (guardAgainst && imageUri === guardAgainst) return undefined
  if (imageUri.startsWith('data:')) return undefined
  const resolved = resolveUri(imageUri)
  // SSRF guard: rendered server-side via next/og <img src> in the OG routes
  // (ImageResponse fetches it during render), and meta.image is
  // attacker-controlled (set at mint). ar:// / ipfs:// resolve to public
  // gateway hosts and pass; a crafted internal https host (or any non-https)
  // is dropped, falling back to the branded text card.
  return isSafePublicHttpsUrl(resolved) ? resolved : undefined
}
