import 'server-only'
import { randomBytes } from 'crypto'
import { redis } from './redis'
import { serverBaseClient } from './rpc'
import { buildIntentMessage, type IntentAction, type IntentEnvelope } from './intent'

/**
 * Server-side intent-nonce + signature verification. The nonce is
 * single-use, 5 min TTL, atomically claimed via DEL only after signature
 * verification succeeds (matches the /api/auth/login pattern — a failed
 * signature attempt doesn't burn a legitimate user's nonce).
 *
 * The signature is verified via viem.verifyMessage which transparently
 * handles both EOA (personal_sign) and ERC-1271 (smart-wallet contract)
 * signatures. ERC-1271 path is critical: most Kismet users hold smart
 * wallets (Coinbase, Farcaster) that don't sign with a raw EOA key.
 */

const NONCE_TTL_SECONDS = 5 * 60
const MAX_EXPIRY_WINDOW = 10 * 60

const intentNonceKey = (nonce: string) => `kismetart:intent-nonce:${nonce}`

export interface IntentNonceIssue {
  nonce: string
  /** Unix seconds — client signs this exact value into the message. */
  expiresAt: number
}

export async function issueIntentNonce(): Promise<IntentNonceIssue> {
  const nonce = randomBytes(16).toString('hex')
  const expiresAt = Math.floor(Date.now() / 1000) + NONCE_TTL_SECONDS
  await redis.set(intentNonceKey(nonce), '1', { nx: true, ex: NONCE_TTL_SECONDS })
  return { nonce, expiresAt }
}

export type IntentVerifyResult =
  | { ok: true }
  | { ok: false; error: string; status: number }

export async function verifyIntent(
  envelope: IntentEnvelope | undefined,
  action: IntentAction,
  account: string,
  bindings: Record<string, string>,
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
  // expiresAt MUST be in the future and within a sane window. Reject
  // expired signatures (≤ now) and ridiculous future-dated ones (> now +
  // 10 min) — both indicate tampering or a client bug.
  if (envelope.expiresAt <= now || envelope.expiresAt > now + MAX_EXPIRY_WINDOW) {
    return { ok: false, error: 'Intent expired or expiry out of range', status: 401 }
  }

  const message = buildIntentMessage(action, bindings, envelope.nonce, envelope.expiresAt)

  // Use the PublicClient's verifyMessage action (not the top-level
  // utility) so ERC-1271 smart-wallet signatures are honored — most
  // Kismet users hold a Coinbase / Farcaster smart wallet that doesn't
  // sign with a raw EOA key. The action falls back to plain EOA recovery
  // when the address is a regular EOA.
  let valid = false
  try {
    valid = await serverBaseClient().verifyMessage({
      address: account as `0x${string}`,
      message,
      signature: envelope.signature as `0x${string}`,
    })
  } catch {
    return { ok: false, error: 'Signature verification failed', status: 401 }
  }
  if (!valid) {
    return { ok: false, error: 'Signature does not match account', status: 401 }
  }

  // Atomic nonce consumption — runs AFTER signature verification so a
  // failed-sig attempt doesn't burn the legitimate user's nonce. DEL
  // returns 1 when the key existed (we just consumed it) or 0 when it
  // didn't (already used by a concurrent request or expired between
  // issue and now).
  const consumed = await redis.del(intentNonceKey(envelope.nonce)).catch(() => 0)
  if (consumed !== 1) {
    return { ok: false, error: 'Nonce already used or expired', status: 401 }
  }

  return { ok: true }
}
