/**
 * SSRF guard for any URL the SERVER will fetch on behalf of a request —
 * Satori/next-og `<img src>` renders (share cards / OG images), Farcaster
 * notification host POSTs, etc. Mirrors @farcaster/miniapp-core's
 * secureUrlSchema (https-only, no IP literals, no localhost) inline so we
 * don't take a direct dependency on a currently-transitive package and so
 * one definition covers every server-fetch sink.
 *
 * Blocks the standard SSRF targets — cloud metadata (169.254.169.254),
 * loopback, and any raw IP literal — while allowing normal public hosts
 * (arweave.net, ipfs gateways, a creator's own CDN). It deliberately does
 * NOT resolve DNS or block internal hostnames; combined with the https-only
 * rule that closes the high-value targets (plaintext internal services,
 * metadata endpoints) without a resolver round-trip on every render.
 */
export function isSafePublicHttpsUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return false
  if (/\s/.test(url)) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const host = parsed.hostname
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  // IPv4 literal (e.g. 169.254.169.254, 127.0.0.1, 10.x, 192.168.x)
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return false
  // IPv6 literal — URL keeps the surrounding brackets on hostname
  if (host.startsWith('[') && host.endsWith(']')) return false
  return true
}
