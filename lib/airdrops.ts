import { redis } from './redis'

/**
 * Record of a single (sender → recipient) airdrop, mirroring the inprocess
 * `/api/airdrops` row shape so ProfileView's airdrops section can render
 * either source through the same `AirdropRecord` interface. We persist this
 * locally because Kismet airdrops are submitted client-side via Zora's
 * `adminMint` (see `hooks/useAirdrop.ts`) — the inprocess relay is bypassed
 * entirely, so their `/api/airdrops` endpoint never observes them.
 */
export interface AirdropRecord {
  collectionAddress: string
  tokenId: string
  recipient: { address: string; username?: string }
  amount: number
  txHash?: string
  timestamp: number
}

const MAX_PER_SENDER = 500
// Airdrops per moment are bounded by recipient count; 500 newest is far more
// than the per-moment activity feed shows and keeps the zset small.
const MAX_PER_MOMENT = 500

const keyBySender = (sender: string) =>
  `kismetart:airdrops:sender:${sender.toLowerCase()}`

// Reverse index: airdrops FOR one moment, so the moment's activity feed can
// list "invited to kismet" rows without knowing (or fanning out over) every
// wallet that airdropped it. Written alongside the sender log in recordAirdrop
// — same forward/reverse dual-index shape as lib/airdropDelegates.ts and
// lib/collected.ts. Member JSON is byte-identical to the sender log's, so an
// idempotent re-record (same timestamp) overwrites rather than duplicates.
const keyByMoment = (collection: string, tokenId: string) =>
  `kismetart:airdrops:moment:${collection.toLowerCase()}:${String(tokenId)}`

/** Parse a zrange reply of JSON-encoded AirdropRecords, skipping bad rows. */
function parseAirdropRows(raws: unknown[]): AirdropRecord[] {
  const out: AirdropRecord[] = []
  for (const raw of raws) {
    try {
      const r = typeof raw === 'string' ? (JSON.parse(raw) as AirdropRecord) : (raw as AirdropRecord)
      out.push(r)
    } catch {
      continue
    }
  }
  return out
}

/**
 * Append one (sender, recipient) pair to both the sender's airdrop log and the
 * moment's reverse index. Multi-recipient airdrops fan out to one row per
 * recipient — same shape inprocess returns, so the ProfileView renderer
 * doesn't need to branch.
 */
export async function recordAirdrop(
  sender: string,
  record: Omit<AirdropRecord, 'timestamp'> & { timestamp?: number },
): Promise<void> {
  const timestamp = record.timestamp ?? Date.now()
  const stored: AirdropRecord = {
    collectionAddress: record.collectionAddress.toLowerCase(),
    tokenId: String(record.tokenId),
    recipient: {
      address: record.recipient.address.toLowerCase(),
      ...(record.recipient.username ? { username: record.recipient.username } : {}),
    },
    amount: record.amount,
    ...(record.txHash ? { txHash: record.txHash } : {}),
    timestamp,
  }
  const member = JSON.stringify(stored)
  const momentKey = keyByMoment(stored.collectionAddress, stored.tokenId)
  // Both writes (and both trims) issue in the same tick — enableAutoPipelining
  // collapses them into one REST round trip.
  await Promise.all([
    redis.zadd(keyBySender(sender), { score: timestamp, member }),
    redis.zadd(momentKey, { score: timestamp, member }),
  ])
  // Trim to bound storage; heaviest airdroppers / most-airdropped moments lose
  // the oldest entries first (acceptable for a "recent activity" view).
  await Promise.all([
    redis.zremrangebyrank(keyBySender(sender), 0, -MAX_PER_SENDER - 1),
    redis.zremrangebyrank(momentKey, 0, -MAX_PER_MOMENT - 1),
  ])
}

/**
 * Delete a sender's entire airdrop-sent log. Used by admin profile-erase:
 * this is the send-side mirror of deleteCollected (the receive side). Both are
 * address-keyed authored activity rendered on the profile (via
 * /api/airdrops?artist=<addr>), so erasing one without the other would leave
 * the sent-airdrops section resurfacing on a rebuilt profile.
 */
export async function deleteAirdropsBySender(sender: string): Promise<void> {
  await redis.del(keyBySender(sender))
}

export async function getAirdropsBySender(
  sender: string,
  opts: { offset?: number; limit?: number } = {},
): Promise<AirdropRecord[]> {
  const offset = Math.max(0, opts.offset ?? 0)
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100))
  const raws = (await redis.zrange(
    keyBySender(sender),
    offset,
    offset + limit - 1,
    { rev: true },
  )) as string[]
  return parseAirdropRows(raws)
}

/**
 * List airdrops FOR one moment, newest first. Powers the "invited to kismet"
 * rows folded into the moment activity feed. Returns [] on any error so the
 * comments route can merge it without a try/catch.
 */
export async function getAirdropsByMoment(
  collection: string,
  tokenId: string,
  opts: { offset?: number; limit?: number } = {},
): Promise<AirdropRecord[]> {
  const offset = Math.max(0, opts.offset ?? 0)
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100))
  try {
    const raws = (await redis.zrange(
      keyByMoment(collection, tokenId),
      offset,
      offset + limit - 1,
      { rev: true },
    )) as string[]
    return parseAirdropRows(raws)
  } catch {
    return []
  }
}
