import sharp from 'sharp'
import { resolveUri } from '@/lib/inprocess'
import { isSafePublicHttpsUrl } from '@/lib/safeUrl'
import {
  bucketWidth,
  readVariant,
  VARIANT_CACHE_DIR,
  variantFileName,
} from '@/lib/media/imgVariantCache'

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

// The card hero renders at 800×800 inside the 1200×800 canvas; 1200 wide
// covers it with headroom while keeping the inlined jpeg small (~100-500KB).
const SHARE_SOURCE_MAX_WIDTH = 1200

/**
 * Like shareImageUrl, but when the cover's downscaled variant is already in
 * /api/img's disk cache (lib/media/imgVariantCache — every proxy-class cover
 * lands there after one site view), return it INLINE as a jpeg data URI
 * instead of the raw gateway URL.
 *
 * WHY: Satori fetches <img src> during the OG render with no timeout and no
 * cache, so a Patron-class physical-art scan meant re-downloading the full
 * >50MB original from the gateway and decoding ~100 megapixels on EVERY
 * crawler hit — Farcaster's embed fetch gives up long before that finishes,
 * which is why exactly this moment's Mini App embed rendered a blank card
 * while every optimizer-eligible moment embedded fine. From the local
 * variant the whole render is sub-second (measured: 2048px webp variant →
 * 1200px jpeg in ~200ms; satori accepts jpeg data URIs beyond 2MB).
 *
 * Format note, validated empirically against the bundled satori: webp is
 * rejected in BOTH data-URI and ArrayBuffer form ("Unsupported image type"),
 * jpeg data URIs render fine at this scale — hence the explicit jpeg
 * re-encode. (The module-header caution about data: URIs is about
 * ATTACKER-SUPPLIED ones — SVG covers — which shareImageUrl still drops;
 * this data URI is built server-side from bytes sharp already verified.)
 *
 * On a miss — no variant cached, or none readable — the source is fetched
 * here and re-encoded the same way, or the card gets nothing. Satori draws a
 * BLANK card for any image it cannot load or decode: measured against the
 * bundled @vercel/og, an unreachable URL and a failed fetch both render as
 * the bare background, `alt` not drawn. So a raw gateway URL was a blank card
 * whenever the upload was still propagating (the first share of anything new),
 * the gateway was slow, the source was past a crawler's patience, or it was a
 * webp. Nothing (undefined) falls back to the branded text card, which always
 * draws. The fetch is bounded in time and size, and each redirect is checked
 * as the first URL was, since a public host can redirect anywhere.
 * `cacheDir` and `fetcher` are injectable for tests; production callers omit
 * them.
 */
export async function shareImageSource(
  imageUri: string | undefined,
  guardAgainst?: string,
  cacheDir: string = VARIANT_CACHE_DIR,
  fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
  const url = shareImageUrl(imageUri, guardAgainst)
  if (!url) return undefined
  if (imageUri && (imageUri.startsWith('ar://') || imageUri.startsWith('ipfs://'))) {
    try {
      // Same key the site's render surfaces write: the RAW ar://ipfs URI at
      // the 2048 bucket (MomentImage's PROXY_DISPLAY_MAX_WIDTH) — the one
      // variant guaranteed warm for any cover a viewer has ever seen.
      const variant = await readVariant(cacheDir, variantFileName(imageUri, bucketWidth(2048)))
      if (variant) return await jpegDataUri(variant)
    } catch {
      // Unreadable or undecodable: fetched below, like a miss.
    }
  }
  try {
    const source = await fetchBounded(url, fetcher)
    return source ? await jpegDataUri(source) : undefined
  } catch {
    return undefined
  }
}

async function jpegDataUri(bytes: Buffer): Promise<string> {
  const jpeg = await sharp(bytes)
    .resize({ width: SHARE_SOURCE_MAX_WIDTH, height: SHARE_SOURCE_MAX_WIDTH, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer()
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`
}

// A crawler's embed fetch gives up within seconds, so the card must render in
// well under that; a source this large is a physical-art scan the text card
// serves better than a half-downloaded one.
const FETCH_BUDGET_MS = 4_000
const FETCH_MAX_BYTES = 30 * 1024 * 1024
const MAX_REDIRECTS = 3

/** The bytes at `url`, or null: past the budget, past the size cap, not a 2xx,
 *  or redirected anywhere shareImageUrl would not have sent it. */
async function fetchBounded(url: string, fetcher: typeof fetch): Promise<Buffer | null> {
  const signal = AbortSignal.timeout(FETCH_BUDGET_MS)
  let at = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetcher(at, { signal, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      const next = location ? new URL(location, at).toString() : null
      if (!next || !isSafePublicHttpsUrl(next)) return null
      at = next
      continue
    }
    if (!res.ok || !res.body) return null
    if (Number(res.headers.get('content-length') ?? 0) > FETCH_MAX_BYTES) return null
    const chunks: Uint8Array[] = []
    let size = 0
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > FETCH_MAX_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  }
  return null
}

// NOTE: the "is this poster flat black?" decision used to live here, reading
// the /api/img 2048 disk variant — but video posters render via MomentImg
// skipProxy and never populate that cache, so the check was dead in the common
// case. It now lives in lib/media/animatedPreview as a warm-time marker
// computed from the actual poster bytes (computePreferStill).
