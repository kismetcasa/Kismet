import { isAddress as viemIsAddress, type Address } from 'viem'
import { normalize } from 'viem/ens'

/**
 * Server-side address validator. EVM addresses are case-insensitive at the
 * protocol layer — viem's default `isAddress` runs strict EIP-55 checksum
 * validation which is useful for client-side typo detection but rejects
 * all-lowercase addresses. Many client paths normalize to lowercase before
 * sending (AirdropForm recipients, distribute split address, profile
 * params), so server validation needs to accept any well-formed hex
 * address regardless of case.
 *
 * Use this everywhere on the server in place of `viem.isAddress`. Client-
 * side input validation should keep using viem's default (strict) so the
 * user sees a typo warning at the source.
 */
export function isAddress(value: unknown): value is Address {
  return typeof value === 'string' && viemIsAddress(value, { strict: false })
}

/** Largest valid ERC-1155/721 token id (uint256). */
const MAX_UINT256 = (1n << 256n) - 1n

/**
 * Validates a token ID as a non-empty decimal string within uint256 range.
 * Single source of truth for the `/^\d+$/` checks scattered across moment +
 * listing routes — use this instead of inlining the regex. The upper bound
 * rejects an out-of-range id at the trust boundary (clean 400) rather than
 * letting it reach a contract read that throws a confusing 5xx.
 */
export function isValidTokenId(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return false
  try {
    return BigInt(value) <= MAX_UINT256
  } catch {
    return false
  }
}

type EnsClientLike = {
  getEnsAddress: (args: { name: string }) => Promise<Address | null>
} | undefined

/**
 * Resolve an ENS name or 0x address to a lowercase 0x. Returns null on
 * unresolved .eth or unmounted client (caller surfaces a toast).
 */
export async function resolveAddressOrEns(
  client: EnsClientLike,
  raw: string,
): Promise<`0x${string}` | null> {
  const trimmed = raw.trim()
  if (viemIsAddress(trimmed)) return trimmed.toLowerCase() as `0x${string}`
  if (trimmed.endsWith('.eth') && client) {
    try {
      // normalize() throws on invalid ENS names (forbidden chars, bad emoji
      // sequences, etc.) — the catch below treats that as unresolvable.
      const resolved = await client.getEnsAddress({ name: normalize(trimmed) })
      return resolved ? (resolved.toLowerCase() as `0x${string}`) : null
    } catch {
      return null
    }
  }
  return null
}
