import { isAddress as viemIsAddress, type Address } from 'viem'

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
