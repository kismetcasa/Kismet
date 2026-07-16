import 'server-only'

/**
 * Ingest the media an MCP mint refers to, into raw bytes we can re-host on
 * Arweave (or a passthrough of an already-permanent URI). The app streams media
 * client → Turbo; an AI assistant can't, so the server ingests it here.
 *
 * Two accepted forms only:
 *   - `data:` URI          → decode (the primary path: the assistant holds the bytes)
 *   - `ar://` / `ipfs://`  → passthrough, no re-upload (already permanent)
 *
 * We deliberately do NOT fetch arbitrary `https://` URLs. The Kismet app never
 * fetches media server-side (the browser has the file and streams it), so a
 * server-side URL fetch is an unforced deviation whose only purpose would be to
 * turn this endpoint into an SSRF vector (fetch attacker-controlled URLs from
 * inside the platform). An assistant that has an https URL can fetch it with its
 * own tools and pass the bytes here as a `data:` URI. Keeping the surface to
 * "bytes the caller already holds" + "an already-permanent URI" removes the SSRF
 * class entirely.
 */

const MAX_MEDIA_BYTES = 25 * 1024 * 1024 // MCP cap; larger files → the Kismet app

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/avif'])
const VIDEO_MIMES = new Set(['video/mp4', 'video/webm', 'video/quicktime'])

export type MediaKind = 'image' | 'video'

export interface IngestResult {
  /** An already-permanent URI supplied by the caller — nothing to upload. */
  passthroughUri?: string
  /** Raw bytes to upload (mutually exclusive with passthroughUri). */
  bytes?: Buffer
  mime: string
  kind: MediaKind
}

function kindOf(mime: string): MediaKind | null {
  const m = mime.split(';')[0].trim().toLowerCase()
  if (IMAGE_MIMES.has(m)) return 'image'
  if (VIDEO_MIMES.has(m)) return 'video'
  return null
}

export function ingestMintMedia(
  media: string,
  declaredKind?: MediaKind,
): IngestResult | { error: string } {
  // 1. Already-permanent URI → passthrough. Mime is unknown, so trust the
  //    declared kind (default image, the common case).
  if (media.startsWith('ar://') || media.startsWith('ipfs://')) {
    const kind = declaredKind ?? 'image'
    return { passthroughUri: media, mime: kind === 'video' ? 'video/mp4' : 'image/*', kind }
  }

  // 2. data: URI → decode locally (no network).
  if (media.startsWith('data:')) {
    const m = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(media)
    if (!m) return { error: 'Malformed data URI' }
    const mime = m[1]
    const bytes = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]))
    const kind = kindOf(mime)
    if (!kind) return { error: `Unsupported media type "${mime}" — image/* or video/* only` }
    if (bytes.length > MAX_MEDIA_BYTES) {
      return { error: `Media too large (${(bytes.length / 1048576).toFixed(1)} MB); MCP mint caps at 25 MB — use the Kismet app for larger files` }
    }
    return { bytes, mime, kind }
  }

  return {
    error:
      'media must be a data: URI (the bytes) or an ar://|ipfs:// URI — the MCP mint does not fetch remote URLs; fetch it yourself and pass the bytes as a data: URI',
  }
}
