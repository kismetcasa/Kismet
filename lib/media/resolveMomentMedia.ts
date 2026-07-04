import { isVideoMoment } from './isVideo'

export type MomentMediaKind = 'video' | 'gif' | 'image' | 'text' | 'none'

interface MediaMeta {
  image?: string
  animation_url?: string
  content?: { mime?: string; uri?: string }
}

export interface ResolvedMedia {
  kind: MomentMediaKind
  /** Primary URL to render: the video src, the (animated) gif src, or the
   *  still-image src. Undefined for `text` / `none`. */
  src?: string
  /** Static poster for the `video`/`gif` kinds when a non-animated image
   *  is also present. Never itself a gif. */
  poster?: string
}

// ar:// content is hash-addressed (no extension), so the extension test
// only catches `https://…/foo.gif`. The `image/gif` mime hint is the
// reliable signal for Kismet mints and most marketplaces.
function isGifUrl(url?: string): boolean {
  return !!url && url.split(/[?#]/, 1)[0]!.toLowerCase().endsWith('.gif')
}

/**
 * Single source of truth for "what does this moment render, and how".
 *
 * Media bytes can live in any of three metadata fields depending on who
 * minted the token and which marketplace's conventions they followed:
 *   - `animation_url` — OpenSea/EIP-1155 convention for video/gif/html
 *   - `content.uri`   — Zora's content extension (with `content.mime`)
 *   - `image`         — the still/poster, but sometimes the only field set
 *
 * Earlier versions only consulted `animation_url`/`image`, so a GIF whose
 * URL sat in `content.uri` (a common Zora shape) fell through to a blank
 * "no preview" tile. This resolver reads all three, classifies a gif by
 * mime OR extension on any of them, and — critically — never returns
 * `none` when ANY renderable URL exists: an unclassifiable URL is still
 * attempted as an image (the card/detail view fall back to the thumbhash
 * blur if it errors), which is strictly better than a blank tile.
 *
 * Precedence: video → text → gif → still image → none.
 */
export function resolveMomentMedia(meta: MediaMeta): ResolvedMedia {
  if (isVideoMoment(meta)) {
    return {
      kind: 'video',
      src: meta.animation_url ?? meta.content?.uri,
      poster: meta.image,
    }
  }

  if (meta.content?.mime === 'text/plain') return { kind: 'text' }

  const animIsGif = isGifUrl(meta.animation_url)
  const contentIsGif = isGifUrl(meta.content?.uri)
  const imageIsGif = isGifUrl(meta.image)
  const mimeIsGif = meta.content?.mime === 'image/gif'
  if (animIsGif || contentIsGif || imageIsGif || mimeIsGif) {
    // Prefer the field that actually carries the animated bytes; the
    // mime-only case (no extension hint) falls back through the same
    // priority order.
    const src =
      (animIsGif && meta.animation_url) ||
      (contentIsGif && meta.content?.uri) ||
      (imageIsGif && meta.image) ||
      meta.animation_url ||
      meta.content?.uri ||
      meta.image
    if (src) {
      // Use `image` as the poster only when it's a distinct, non-animated
      // still — never when `image` IS the gif we're rendering.
      const poster =
        meta.image && meta.image !== src && !isGifUrl(meta.image)
          ? meta.image
          : undefined
      return { kind: 'gif', src, poster }
    }
  }

  // Ambiguous animation_url → attempt VIDEO. ar:// URIs carry no extension
  // and many mints (Kismet's own until content.mime was added at mint time,
  // plus external ones) rely on the inprocess indexer to attach the mime —
  // when that enrichment is missing (e.g. /timeline rows with content:null,
  // see VIDEO_PLAYBACK_RCA.md) the moment used to fall through to the
  // still-image branch and a <video> never mounted on feed surfaces, even
  // though the detail page (whose /moment copy carries the mime) played it.
  // A wrong guess is cheap and self-healing: a non-video animation_url
  // errors in <video>, MomentVideo falls back to the poster — exactly what
  // rendered before — and InlineVideo rejects sources with no video track
  // (audio files) before they can present as a silent black box.
  const anim = meta.animation_url
  if (anim) {
    const mime = meta.content?.mime
    // A mime hint vetoes the attempt only when it plausibly describes the
    // animation bytes (content.uri IS the animation_url, or there's no
    // content.uri at all) and names a concrete non-video type — video/*,
    // text/plain, and image/gif were all handled above. A mime describing a
    // DIFFERENT uri (e.g. Zora content pointing at the still) says nothing
    // about the animation.
    const mimeDescribesAnim = !!mime && (!meta.content?.uri || meta.content.uri === anim)
    const vetoedByMime = mimeDescribesAnim && mime !== 'application/octet-stream'
    // Known non-video extensions keep their current handling: stills fall
    // through to the image branch below; audio/document types were never
    // renderable here and keep degrading to the poster path.
    const NON_VIDEO_EXT =
      /\.(png|jpe?g|webp|avif|svg|mp3|wav|ogg|oga|flac|m4a|aac|opus|html?|pdf|txt|json|zip|glb|gltf|usdz)$/
    const animPath = anim.split(/[?#]/, 1)[0]!.toLowerCase()
    if (!vetoedByMime && !NON_VIDEO_EXT.test(animPath)) {
      return { kind: 'video', src: anim, poster: meta.image }
    }
  }

  // Still image, or any renderable URL we couldn't classify — attempt it
  // rather than show a blank tile. The render surfaces fall back to the
  // thumbhash blur if every gateway errors.
  const src = meta.image ?? meta.content?.uri ?? meta.animation_url
  if (src) return { kind: 'image', src }
  return { kind: 'none' }
}
