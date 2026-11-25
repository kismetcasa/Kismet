import 'server-only'
import { isAddress } from './address'
import { consumeNonce } from './profile'
import { getMomentMeta } from './notifications'
import { ADMIN_ADDRESS } from './config'
import { serverBaseClient } from './rpc'
import { isOnchainMomentAdmin } from './momentAuthz'
import {
  buildRaffleManageMessage,
  type RaffleManageFields,
} from './raffleManageMessage'

/**
 * Authorize an artist (or admin) to manage a moment's raffle, mirroring the
 * /api/distribute model so raffles are self-serve without Kismet in the loop:
 *
 *   1. The caller signs a nonce'd message binding the exact action + params
 *      (verified here, ERC-1271-aware so smart wallets work).
 *   2. The nonce is consumed (single-use replay protection).
 *   3. The caller must be the moment's creator (KV mint-meta), a moment admin
 *      (ADMIN on the token or collection-wide, read from chain —
 *      lib/momentAuthz), or the platform admin.
 *
 * Returns { ok: true, caller } or { ok: false, status, error } so the route can
 * short-circuit with one check.
 */
export type RaffleAuthResult =
  | { ok: true; caller: string }
  | { ok: false; status: number; error: string }

export async function authorizeRaffleManager(
  fields: RaffleManageFields & { signature: string },
): Promise<RaffleAuthResult> {
  const { collection, tokenId, address, signature, nonce } = fields

  if (!address || !isAddress(address)) {
    return { ok: false, status: 401, error: 'callerAddress required' }
  }
  if (!signature || !nonce) {
    return { ok: false, status: 401, error: 'signature and nonce required' }
  }

  // Rebuild the EXACT message from server-trusted fields so the signature binds
  // (action, collection, tokenId, winner/closeAt, address, nonce).
  const message = buildRaffleManageMessage(fields)
  let valid = false
  try {
    valid = await serverBaseClient().verifyMessage({
      address: address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    })
  } catch {
    return { ok: false, status: 401, error: 'Signature verification failed' }
  }
  if (!valid) return { ok: false, status: 401, error: 'Signature does not match wallet' }

  // Verify-then-consume: a failed sig leaves the nonce reusable.
  if (!(await consumeNonce(address, nonce))) {
    return { ok: false, status: 401, error: 'Invalid or expired nonce' }
  }

  const callerLower = address.toLowerCase()

  // Platform admin — break-glass / support lever.
  if (!!ADMIN_ADDRESS && callerLower === ADMIN_ADDRESS) {
    return { ok: true, caller: callerLower }
  }

  // KV moment-meta creator — the EOA the mint-proxy recorded at mint. The
  // creator's own wallet often holds no ADMIN bit (delegated mints run through
  // the platform smart wallet), so this is what lets them in.
  const meta = await getMomentMeta(collection, tokenId)
  if (meta?.creator?.toLowerCase() === callerLower) {
    return { ok: true, caller: callerLower }
  }

  // Moment admin: ADMIN on this token or collection-wide, read from chain
  // (lib/momentAuthz), only when the cheap signals didn't already authorize.
  // On a curated collection that includes every collection admin — the same
  // wallets that can already rewrite this token's sale and metadata on chain.
  try {
    const isAdmin = await isOnchainMomentAdmin(
      serverBaseClient(),
      collection as `0x${string}`,
      BigInt(tokenId),
      callerLower as `0x${string}`,
    )
    if (isAdmin) return { ok: true, caller: callerLower }
  } catch {
    return { ok: false, status: 502, error: 'Could not verify artwork admin' }
  }

  return {
    ok: false,
    status: 403,
    error: 'Only the artwork creator or an admin can manage this raffle',
  }
}
