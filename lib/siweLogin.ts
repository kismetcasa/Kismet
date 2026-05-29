import 'server-only'
import { parseSiweMessage, verifySiweMessage } from 'viem/siwe'
import { serverBaseClient } from './rpc'

/**
 * Server-side SIWE message verification shared by the admin and user
 * login paths. Returns the verified signer on success, or { error, status }
 * on any failure so callers can short-circuit with one check.
 *
 * Three hard checks happen here:
 *   1. The message parses as EIP-4361 SIWE (well-formed domain/address/nonce).
 *   2. The message's `domain` field matches the request's Host header —
 *      a signature obtained for our domain on a phishing clone (same
 *      message text rendered to the user on attacker.com) cannot be
 *      replayed against the real host.
 *   3. The signature recovers to the address claimed in the message,
 *      with EIP-1271 support via serverBaseClient's verifyHash path.
 *
 * Nonce consumption is intentionally NOT done here — different callers
 * use different nonce ledgers (admin keys by nonce, user keys by
 * address) and each consumes after privilege checks specific to its
 * surface. Callers parse `nonce` off the returned record and consume it
 * themselves on success.
 */
export interface SiweVerified {
  address: string
  nonce: string
}

export interface SiweError {
  error: string
  status: number
}

export async function verifySiweLogin(
  message: string,
  signature: string,
  expectedHost: string | null | undefined,
): Promise<SiweVerified | SiweError> {
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
    return { error: 'Invalid signature shape', status: 400 }
  }

  let parsed
  try {
    parsed = parseSiweMessage(message)
  } catch {
    return { error: 'Invalid SIWE message', status: 400 }
  }
  const { address, nonce, domain } = parsed
  if (!address || !nonce || !domain) {
    return { error: 'SIWE message missing required fields', status: 400 }
  }

  // Host header is case-insensitive per HTTP; clients (RainbowKit, miniapp
  // wallets) may normalize differently — compare lowercased.
  const host = expectedHost?.toLowerCase()
  if (!host || domain.toLowerCase() !== host) {
    return { error: 'Domain mismatch', status: 401 }
  }

  const verified = await verifySiweMessage(serverBaseClient(), {
    message,
    signature: signature as `0x${string}`,
    domain: host,
    nonce,
  })
  if (!verified) {
    return { error: 'Signature verification failed', status: 401 }
  }

  return { address: address.toLowerCase(), nonce }
}
