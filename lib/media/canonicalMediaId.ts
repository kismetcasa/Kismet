/**
 * Reduce a media URL to a canonical content identifier so two
 * differently-formatted URLs that point at the same Arweave/IPFS content
 * compare equal.
 *
 * Same txid via different gateways or schemes all collapse to one id:
 *   ar://AbC...                          → ar:AbC...
 *   https://arweave.net/AbC...           → ar:AbC...
 *   https://permagate.io/AbC...          → ar:AbC...
 *   https://g8way.io/AbC.../thumb.png    → ar:AbC.../thumb.png
 *   ipfs://bafy.../foo                   → ipfs:bafy.../foo
 *   https://ipfs.io/ipfs/bafy.../foo     → ipfs:bafy.../foo
 *   https://bafy....ipfs.dweb.link/foo   → ipfs:bafy.../foo
 *
 * Anything else (data: URIs, opaque https) falls back to a lowercased,
 * trimmed string so direct equality still works for identical inputs.
 *
 * Used by featured-collection dedupe to suppress the moment whose image
 * is the collection cover. Cover URLs originate in our own KV (stored as
 * the upload returned them, often ar://), while moment URLs come back
 * from inprocess (often already-resolved gateway URLs), so raw-string
 * comparison misses the duplicate.
 */

// Arweave txids are SHA-256 hashes base64url-encoded → exactly 43 chars
// over [A-Za-z0-9_-]. Tight enough that random path segments don't
// accidentally match.
const ARWEAVE_TXID = /^[A-Za-z0-9_-]{43}$/

export function canonicalMediaId(url: string | undefined | null): string | undefined {
  if (!url) return undefined
  const trimmed = url.trim()
  if (!trimmed) return undefined

  if (trimmed.startsWith('ar://')) {
    return `ar:${trimmed.slice(5).split(/[?#]/)[0]}`
  }
  if (trimmed.startsWith('ipfs://')) {
    return `ipfs:${trimmed.slice(7).split(/[?#]/)[0]}`
  }

  try {
    const u = new URL(trimmed)
    // Path-style IPFS: /ipfs/<cid>[/<path>] on any host
    const ipfsPath = u.pathname.match(/\/ipfs\/(.+?)\/?$/)
    if (ipfsPath) return `ipfs:${ipfsPath[1]}`
    // Subdomain-style IPFS: <cid>.ipfs.<host> with optional path appended
    const ipfsSub = u.hostname.match(/^([^.]+)\.ipfs\./)
    if (ipfsSub) {
      const path = u.pathname.replace(/^\//, '')
      return `ipfs:${ipfsSub[1]}${path ? `/${path}` : ''}`
    }
    // Arweave gateway: first path segment is a 43-char txid. Works for
    // any AR.IO gateway (arweave.net, permagate.io, g8way.io, ar-io.dev,
    // Irys/Turbo gateways, …) without hardcoding the host list.
    const segs = u.pathname.split('/').filter(Boolean)
    if (segs.length >= 1 && ARWEAVE_TXID.test(segs[0])) {
      const rest = segs.slice(1).join('/')
      return `ar:${segs[0]}${rest ? `/${rest}` : ''}`
    }
  } catch {
    // not a parseable URL — fall through to the opaque-string path
  }

  return trimmed.toLowerCase()
}
