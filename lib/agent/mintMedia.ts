import 'server-only'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * Ingest the media an MCP mint refers to, into raw bytes we can re-host on
 * Arweave (or a passthrough of an already-permanent URI). The app streams media
 * client → Turbo; an AI assistant can't, so the server ingests it here. Three
 * accepted forms (mirrors Base's Zora `coinIt`, which takes a local file OR an
 * ipfs://https:// URI):
 *   - `data:` URI            → decode (the primary path: the assistant has bytes)
 *   - `ar://` / `ipfs://`    → passthrough, no re-upload (already permanent)
 *   - `https://` URL         → SSRF-guarded fetch, then re-host
 *
 * SSRF is the real risk (fetching an attacker-controlled URL server-side), so
 * the https path is https-only, resolves DNS and rejects any private/reserved
 * address, refuses redirects, and caps size + time. This surface is additionally
 * bounded upstream by the Pass gate (only eligible artists reach it).
 */

const MAX_MEDIA_BYTES = 25 * 1024 * 1024 // MCP cap; larger files → the Kismet app
const FETCH_TIMEOUT_MS = 15_000

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

/** SSRF guard: reject loopback / private / link-local (incl. cloud metadata) /
 *  CGNAT / ULA / multicast / reserved addresses. */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) {
    const p = ip.split('.').map(Number)
    if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true
    const [a, b] = p
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true // link-local incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a >= 224) return true // multicast + reserved
    return false
  }
  if (v === 6) {
    const ip6 = ip.toLowerCase()
    if (ip6 === '::1' || ip6 === '::') return true
    if (ip6.startsWith('fc') || ip6.startsWith('fd')) return true // ULA fc00::/7
    if (ip6.startsWith('fe80')) return true // link-local
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip6)
    if (mapped) return isBlockedIp(mapped[1]) // IPv4-mapped
    return false
  }
  return true // not a valid IP literal → block
}

export async function ingestMintMedia(
  media: string,
  declaredKind?: MediaKind,
): Promise<IngestResult | { error: string }> {
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

  // 3. https:// URL → SSRF-guarded fetch + re-host.
  if (media.startsWith('https://')) {
    let url: URL
    try {
      url = new URL(media)
    } catch {
      return { error: 'Invalid media URL' }
    }
    if (isIP(url.hostname)) {
      if (isBlockedIp(url.hostname)) return { error: 'Media URL points at a blocked address' }
    } else {
      try {
        const addrs = await lookup(url.hostname, { all: true })
        if (addrs.length === 0 || addrs.some((a) => isBlockedIp(a.address))) {
          return { error: 'Media URL resolves to a blocked address' }
        }
      } catch {
        return { error: 'Could not resolve the media URL host' }
      }
    }

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(url, { redirect: 'error', signal: ctrl.signal, headers: { accept: 'image/*,video/*' } })
      if (!res.ok) return { error: `Media fetch failed (${res.status})` }
      const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
      const kind = kindOf(mime)
      if (!kind) return { error: `Unsupported media type "${mime || 'unknown'}" — image/* or video/* only` }
      const reader = res.body?.getReader()
      if (!reader) return { error: 'Empty media response' }
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.length
        if (total > MAX_MEDIA_BYTES) {
          await reader.cancel()
          return { error: 'Media too large (max 25 MB via MCP)' }
        }
        chunks.push(value)
      }
      return { bytes: Buffer.concat(chunks), mime, kind }
    } catch (e) {
      return { error: e instanceof Error && e.name === 'AbortError' ? 'Media fetch timed out' : 'Media fetch failed' }
    } finally {
      clearTimeout(timer)
    }
  }

  return { error: 'media must be a data: URI, an ar://|ipfs:// URI, or an https:// URL' }
}
