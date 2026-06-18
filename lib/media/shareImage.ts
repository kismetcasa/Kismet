import { resolveUri } from '@/lib/inprocess'
import { isSafePublicHttpsUrl } from '@/lib/safeUrl'
import { SITE_URL } from '@/lib/siteUrl'

interface ShareImageOptions {
  /**
   * Route the resolved gateway URL through Next's image optimizer
   * (`/_next/image`) instead of returning it raw. Use this for the
   * `og:image` / `twitter:image` tags read by share crawlers: it resizes
   * to 1200px wide and re-encodes (WebP/AVIF for clients that advertise
   * support via Accept, resized original otherwise), which keeps the
   * payload under Twitter's ~5MB card-image limit. Without it, a creator
   * who uploaded a 15MB+ PNG cover ships that raw file as og:image and X
   * silently drops the image, rendering a broken-placeholder card.
   *
   * Left off for the next/og (`/opengraph-image`) Satori callers — those
   * re-render the source into a fixed 1200x800 canvas, so the output is
   * already bounded and an extra optimizer hop would only add a self-fetch.
   */
  optimize?: boolean
}

/**
 * Build a share-card image URL (og:image / twitter:image) from a moment
 * or collection's `meta.image`. Three guard rails:
 *
 *   1. Skip when no image is set — crawlers omit the image entirely and
 *      fall back to text-only cards rather than rendering a 404.
 *   2. Skip when the image equals the moment's animation_url — legacy
 *      MintForm bug wrote the video URL into meta.image, so crawlers
 *      would try to render a multi-MB MP4 as a thumbnail and fail.
 *   3. Skip `data:` URIs — Twitter and Discord don't reliably embed
 *      them. Text-mint auto-deploy generates SVG data URIs for
 *      collection covers; those work in-app but not for share cards.
 *
 * Resolves ar:// / ipfs:// to the canonical gateway URL. With
 * `optimize: true` the resolved URL is wrapped in Next's image optimizer
 * (same `/_next/image` path + remotePatterns MomentImage already uses
 * in-app) so oversized covers are resized below crawler size limits;
 * without it the raw gateway URL is returned for the Satori OG routes.
 */
export function shareImageUrl(
  imageUri: string | undefined,
  guardAgainst?: string,
  opts: ShareImageOptions = {},
): string | undefined {
  if (!imageUri) return undefined
  if (guardAgainst && imageUri === guardAgainst) return undefined
  if (imageUri.startsWith('data:')) return undefined
  const resolved = resolveUri(imageUri)
  // SSRF guard: this URL is rendered server-side via next/og <img src> in the
  // moment/collection OG routes (ImageResponse fetches it during render), and
  // meta.image is attacker-controlled (set at mint). ar:// / ipfs:// resolve
  // to public gateway hosts and pass; a crafted internal https host (or any
  // non-https) is dropped, falling back to the text-only branded card. Also
  // correct for the crawler og:image use — internal URLs wouldn't render there
  // either.
  if (!isSafePublicHttpsUrl(resolved)) return undefined
  // Crawler path: hand X/Discord/iMessage a resized, re-encoded copy from our
  // own origin rather than the raw multi-MB gateway file. `/_next/image`
  // validates the host against images.remotePatterns independently, so the
  // SSRF guard above is belt-and-suspenders here. Absolute URL (SITE_URL) so
  // the tag is valid even where metadataBase resolution doesn't apply.
  if (opts.optimize) {
    return `${SITE_URL}/_next/image?url=${encodeURIComponent(resolved)}&w=1200&q=75`
  }
  return resolved
}
