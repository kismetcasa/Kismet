import { resolveUri } from '@/lib/inprocess'

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
 * Resolves ar:// / ipfs:// to the canonical gateway URL so crawlers
 * fetch directly from arweave.net / ipfs.io. Used to route through
 * /api/img for multi-gateway resilience, but the resilience matters
 * less for low-frequency crawler traffic than for in-app rendering,
 * and a direct URL skips one hop and keeps bytes off our server.
 */
export function shareImageUrl(
  imageUri: string | undefined,
  guardAgainst?: string,
): string | undefined {
  if (!imageUri) return undefined
  if (guardAgainst && imageUri === guardAgainst) return undefined
  if (imageUri.startsWith('data:')) return undefined
  return resolveUri(imageUri)
}
