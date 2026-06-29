import 'server-only'
import { isAddress } from './address'
import { consumeNonce } from './profile'
import { getMomentMeta } from './notifications'
import { inprocessUrl } from './inprocess'
import { ADMIN_ADDRESS } from './config'
import { serverBaseClient } from './rpc'
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
 *      (inprocess /moment), or the platform admin.
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

  // KV moment-meta creator — the EOA the mint-proxy recorded at mint. Preferred
  // over inprocess's momentAdmins, which often lists the platform smart wallet
  // rather than the creator's EOA.
  const meta = await getMomentMeta(collection, tokenId)
  if (meta?.creator?.toLowerCase() === callerLower) {
    return { ok: true, caller: callerLower }
  }

  // Fall back to inprocess's momentAdmins (creator or delegated admin) only when
  // the cheap signals didn't already authorize — saves an upstream round-trip.
  try {
    const url = inprocessUrl('/moment', {
      collectionAddress: collection,
      tokenId,
      chainId: '8453',
    })
    const r = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!r.ok) return { ok: false, status: 403, error: 'Could not verify moment creator' }
    const d = (await r.json()) as { momentAdmins?: unknown }
    const admins = Array.isArray(d.momentAdmins)
      ? d.momentAdmins
          .filter((a): a is string => typeof a === 'string')
          .map((a) => a.toLowerCase())
      : []
    if (admins.includes(callerLower)) return { ok: true, caller: callerLower }
  } catch {
    return { ok: false, status: 502, error: 'Could not verify moment creator' }
  }

  return {
    ok: false,
    status: 403,
    error: 'Only the moment creator or an admin can manage this raffle',
  }
}
