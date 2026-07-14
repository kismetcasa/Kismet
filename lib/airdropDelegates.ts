import { redis } from './redis'
import { isAddress } from './address'

/**
 * Per-piece airdrop delegation. A collection admin (e.g. kismetart.eth) can
 * authorize a specific wallet to airdrop ONE moment from that wallet's own
 * session. Storage mirrors lib/splits.ts:
 *
 *  - forward set  `…:<collection>:<tokenId>` → delegate addresses, for the
 *    admin's manage/revoke list on that piece.
 *  - reverse index `…:by-wallet:<wallet>`    → `<collection>:<tokenId>`, so
 *    the timeline airdroppable filter finds a wallet's delegated pieces in a
 *    single SMEMBERS (symmetric with getRecipientSplits).
 *
 * Discovery only. The on-chain MINTER grant + Zora's adminMint gate remain
 * the sole authority: a stale or bogus entry can never enable an airdrop
 * because the timeline re-verifies on-chain authority before surfacing, and
 * adminMint itself reverts without the grant. This is why the write path is
 * gated but not security-critical — see app/api/moment/airdrop-delegates.
 */

const momentKey = (collection: string, tokenId: string) =>
  `kismetart:airdrop-delegates:${collection.toLowerCase()}:${tokenId}`

const walletKey = (wallet: string) =>
  `kismetart:airdrop-delegates:by-wallet:${wallet.toLowerCase()}`

export interface DelegatedMoment {
  collection: string
  tokenId: string
}

/** Record `delegate` as an airdrop delegate on one moment (idempotent). */
export async function addAirdropDelegate(
  collection: string,
  tokenId: string,
  delegate: string,
): Promise<void> {
  const c = collection.toLowerCase()
  const d = delegate.toLowerCase()
  await Promise.all([
    redis.sadd(momentKey(c, tokenId), d).catch(() => {}),
    redis.sadd(walletKey(d), `${c}:${tokenId}`).catch(() => {}),
  ])
}

/** Drop a delegation from both the forward set and the reverse index. */
export async function removeAirdropDelegate(
  collection: string,
  tokenId: string,
  delegate: string,
): Promise<void> {
  const c = collection.toLowerCase()
  const d = delegate.toLowerCase()
  await Promise.all([
    redis.srem(momentKey(c, tokenId), d).catch(() => {}),
    redis.srem(walletKey(d), `${c}:${tokenId}`).catch(() => {}),
  ])
}

/** Delegate addresses recorded on one moment (lowercased). For the admin UI. */
export async function getAirdropDelegates(
  collection: string,
  tokenId: string,
): Promise<string[]> {
  try {
    const members = (await redis.smembers(
      momentKey(collection, tokenId),
    )) as string[]
    return members
      .filter((m) => typeof m === 'string' && isAddress(m))
      .map((m) => m.toLowerCase())
  } catch {
    return []
  }
}

/** Moments this wallet has been delegated airdrop rights on. One SMEMBERS. */
export async function getDelegatedMoments(
  wallet: string,
): Promise<DelegatedMoment[]> {
  let members: string[]
  try {
    members = (await redis.smembers(walletKey(wallet))) as string[]
  } catch {
    return []
  }
  const out: DelegatedMoment[] = []
  const seen = new Set<string>()
  for (const m of members) {
    if (typeof m !== 'string') continue
    const idx = m.indexOf(':')
    if (idx <= 0) continue
    const collection = m.slice(0, idx)
    const tokenId = m.slice(idx + 1)
    if (!isAddress(collection) || !tokenId) continue
    const key = `${collection.toLowerCase()}:${tokenId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ collection: collection.toLowerCase(), tokenId })
  }
  return out
}
