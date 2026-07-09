// Pool of public AR.IO gateways federating the same Arweave data. Each has
// its own CDN edge cache, so a stale 404 cached at one (e.g. CDN77 in front
// of arweave.net during the propagation window) doesn't block verification
// or rendering on the others. Order matters: arweave.net is canonical and
// listed first so healthy moments load from it without paying any fallback.
//
// Pruned 2026-05: g8way.io stopped resolving (NXDOMAIN) and ar-io.dev's
// cert expired, producing console noise + wasted RTT on every fallback walk.
// Pruned 2026-06: permagate.io began throwing ERR_SSL_PROTOCOL_ERROR (TLS
// outage) — it hard-failed every probe and, alongside arweave.net's
// propagation lag on fresh Turbo uploads, was sinking pre-mint verification.
// Verify newly-added entries with `curl -I https://<host>/<known-txid>` —
// dead gateways stall the fallback chain rather than failing fast.
// Pruned 2026-06 (b): arweave.dev went NXDOMAIN (ERR_NAME_NOT_RESOLVED in the
// browser) - it was the only fallback, so its DNS death meant every verify and
// every render-fallback walk hit a dead host first. Removing it leaves
// arweave.net (Turbo's optimistic-cache host) as the sole gateway; re-add a
// curl-verified AR.IO gateway here to restore fallback redundancy.
const ARWEAVE_GATEWAYS = [
  'https://arweave.net',
] as const

const IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs',
  'https://dweb.link/ipfs',
] as const

/**
 * Return all candidate gateway URLs for a moment URI. ar:// fans out across
 * ARWEAVE_GATEWAYS, ipfs:// across IPFS_GATEWAYS. Anything else (https://,
 * blob:, data:) is returned as a single-element array so callers can iterate
 * uniformly without special-casing.
 */
export function gatewayUrls(uri: string): string[] {
  if (!uri) return []
  if (uri.startsWith('ar://')) {
    const id = uri.slice(5)
    return ARWEAVE_GATEWAYS.map((g) => `${g}/${id}`)
  }
  if (uri.startsWith('ipfs://')) {
    const cid = uri.slice(7)
    return IPFS_GATEWAYS.map((g) => `${g}/${cid}`)
  }
  return [uri]
}
