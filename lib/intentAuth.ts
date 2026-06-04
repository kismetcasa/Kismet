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

export async function verifyIntent(
  envelope: IntentEnvelope | undefined,
  action: IntentAction,
  account: string,
  body: MintBody,
): Promise<IntentVerifyResult> {
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

  // Rebuild the exact typed-data message the client signed. Any tampered
  // body field flips one of the typed slots and the signature fails.
  const message = buildMintIntent(body, action, envelope.nonce, envelope.expiresAt)

  // verifyTypedData handles both EOA recovery and ERC-1271 smart-wallet
  // signatures (via the same verifyHash path verifyMessage uses).
  let valid = false
  try {
    valid = await serverBaseClient().verifyTypedData({
      address: account as `0x${string}`,
      domain: KISMET_INTENT_DOMAIN,
      types: MINT_INTENT_TYPES,
      primaryType: 'MintIntent',
      message: message as unknown as Record<string, unknown>,
      signature: envelope.signature as `0x${string}`,
    })
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
