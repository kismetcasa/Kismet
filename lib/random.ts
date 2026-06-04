/**
 * Cryptographically-strong random hex string, `bytes` long (→ `2 * bytes`
 * hex chars: 128 bits at 16, 256 bits at 32).
 *
 * Uses the Web Crypto `getRandomValues` global — available on Node 20+ and
 * every edge runtime — rather than Node's `crypto.randomBytes`. No Node
 * `crypto` import and no `Buffer`, so callers stay runtime-agnostic and
 * nothing here pins a route to the Node.js runtime. Output is lowercase hex,
 * so nonces stay SIWE-compliant (`^[a-zA-Z0-9]+$`).
 */
export function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}
