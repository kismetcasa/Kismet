import 'server-only'
import { randomHex } from './random'
import { redis } from './redis'
import { serverBaseClient } from './rpc'
import {
  buildMintIntent,
  KISMET_INTENT_DOMAIN,
  MINT_INTENT_TYPES,
  type IntentAction,
  type IntentEnvelope,
  type MintBody,
} from './intent'

/**
 * Server-side intent-nonce + EIP-712 typed-data verification. The nonce
 * is single-use, 5 min TTL, atomically claimed via DEL only AFTER a
 * successful signature check (matches /api/auth/login — failed sigs
 * don't burn a legitimate user's nonce).
 *
 * Signature path: serverBaseClient().verifyTypedData calls verifyHash
 * which supports both EOA recovery and ERC-1271 contract signatures
 * (smart wallets), so Kismet's Coinbase / Farcaster smart-wallet users
 * are covered with no special-casing.
 */

const NONCE_TTL_SECONDS = 5 * 60
const MAX_EXPIRY_WINDOW = 10 * 60

const intentNonceKey = (nonce: string) => `kismetart:intent-nonce:${nonce}`

interface IntentNonceIssue {
  nonce: string
  /** Unix seconds — client signs this exact value into the typed data. */
  expiresAt: number
}

export async function issueIntentNonce(): Promise<IntentNonceIssue> {
  const nonce = randomHex(16)
  const expiresAt = Math.floor(Date.now() / 1000) + NONCE_TTL_SECONDS
  await redis.set(intentNonceKey(nonce), '1', { nx: true, ex: NONCE_TTL_SECONDS })
  return { nonce, expiresAt }
}

type IntentVerifyResult =
  | { ok: true }
  | { ok: false; error: string; status: number }

/**
 * Verify a mint/write intent: the MintIntent typed data rebuilt from the body,
 * through the one implementation below. Any tampered body field flips one of
 * the typed slots and the signature fails.
 */
export function verifyIntent(
  envelope: IntentEnvelope | undefined,
  action: IntentAction,
  account: string,
  body: MintBody,
): Promise<IntentVerifyResult> {
  return verifyTypedIntent({
    envelope,
    account,
    types: MINT_INTENT_TYPES,
    primaryType: 'MintIntent',
    buildMessage: (nonce, expiresAt) =>
      buildMintIntent(body, action, nonce, expiresAt) as unknown as Record<string, unknown>,
  })
}

/**
 * Envelope checks, signature verification and single-use nonce consumption
 * for any Kismet intent: MintIntent (verifyIntent above) and claim drops'
 * OpenDrop / ClaimDrop (lib/drops.ts). Same domain, same nonce namespace — a
 * nonce is consumed once whichever intent spends it — and the distinct
 * primaryType + `action` slot keep one kind of signature from ever verifying
 * as another.
 */
export async function verifyTypedIntent(params: {
  envelope: IntentEnvelope | undefined
  account: string
  types: Record<string, readonly { name: string; type: string }[]>
  primaryType: string
  buildMessage: (nonce: string, expiresAt: number) => Record<string, unknown>
}): Promise<IntentVerifyResult> {
  const { envelope, account, types, primaryType, buildMessage } = params
  if (
    !envelope ||
    typeof envelope.signature !== 'string' ||
    typeof envelope.nonce !== 'string' ||
    typeof envelope.expiresAt !== 'number'
  ) {
    return { ok: false, error: 'Missing or malformed intent envelope', status: 401 }
  }
  if (!/^0x[0-9a-fA-F]+$/.test(envelope.signature)) {
    return { ok: false, error: 'Invalid signature shape', status: 401 }
  }
  if (!/^[0-9a-f]{32}$/.test(envelope.nonce)) {
    return { ok: false, error: 'Invalid nonce shape', status: 401 }
  }

  const now = Math.floor(Date.now() / 1000)
  if (envelope.expiresAt <= now || envelope.expiresAt > now + MAX_EXPIRY_WINDOW) {
    return { ok: false, error: 'Intent expired or expiry out of range', status: 401 }
  }

  // verifyTypedData handles both EOA recovery and ERC-1271 smart-wallet
  // signatures (via the same verifyHash path verifyMessage uses). The types
  // table is the caller's, which viem's compile-time inference can't follow;
  // viem still checks the message against it at runtime when it hashes.
  const client = serverBaseClient()
  const args = {
    address: account as `0x${string}`,
    domain: KISMET_INTENT_DOMAIN,
    types,
    primaryType,
    message: buildMessage(envelope.nonce, envelope.expiresAt),
    signature: envelope.signature as `0x${string}`,
  } as unknown as Parameters<typeof client.verifyTypedData>[0]

  let valid = false
  try {
    valid = await client.verifyTypedData(args)
  } catch {
    return { ok: false, error: 'Signature verification failed', status: 401 }
  }
  if (!valid) {
    return { ok: false, error: 'Signature does not match account', status: 401 }
  }

  // Atomic nonce consumption — last step, so failed signatures don't burn
  // the legitimate user's nonce. DEL returns 1 when we just consumed a
  // valid nonce; 0 means it was already used by a concurrent request or
  // expired between issue and now.
  const consumed = await redis.del(intentNonceKey(envelope.nonce)).catch(() => 0)
  if (consumed !== 1) {
    return { ok: false, error: 'Nonce already used or expired', status: 401 }
  }
  return { ok: true }
}
