// Pool of public AR.IO gateways federating the same Arweave data. Each has
// its own CDN edge cache, so a stale 404 cached at one (e.g. CDN77 in front
// of arweave.net during the propagation window) doesn't block verification
// or rendering on the others. Order matters: arweave.net is canonical and
// listed first so healthy moments load from it without paying any fallback.
export const ARWEAVE_GATEWAYS = [
  'https://arweave.net',
  'https://permagate.io',
  'https://g8way.io',
  'https://ar-io.dev',
] as const

export const IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs',
  'https://dweb.link/ipfs',
  'https://cloudflare-ipfs.com/ipfs',
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
