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

/**
 * One-shot migration: populate the per-moment reverse index from the existing
 * per-sender logs. recordAirdrop writes both indices going forward, but
 * airdrops recorded before the reverse index existed live only under their
 * sender key — this SCANs those keys and re-indexes each record by moment so
 * historical airdrops surface in the activity feed. Idempotent (zadd by the
 * same member overwrites), so it's safe to re-run. Admin-triggered via
 * POST /api/admin/airdrop-reindex.
 */
export async function backfillMomentIndex(): Promise<{
  sendersScanned: number
  recordsReindexed: number
}> {
  let cursor = '0'
  let sendersScanned = 0
  let recordsReindexed = 0
  const touchedMomentKeys = new Set<string>()
  do {
    const [next, keys] = await redis.scan(cursor, {
      match: 'kismetart:airdrops:sender:*',
      count: 200,
    })
    cursor = next
    for (const senderKey of keys) {
      sendersScanned++
      const raws = (await redis.zrange(senderKey, 0, -1, { rev: true })) as string[]
      const records = parseAirdropRows(raws)
      // Group by moment so each moment's rows go in one zadd (autopipelined).
      const byMoment = new Map<string, { score: number; member: string }[]>()
      for (const r of records) {
        if (!r.collectionAddress || !r.tokenId || typeof r.timestamp !== 'number') continue
        const key = keyByMoment(r.collectionAddress, r.tokenId)
        const entry = { score: r.timestamp, member: JSON.stringify(r) }
        const bucket = byMoment.get(key)
        if (bucket) bucket.push(entry)
        else byMoment.set(key, [entry])
      }
      for (const [momentKey, entries] of byMoment) {
        touchedMomentKeys.add(momentKey)
        // zadd requires a first score-member; entries always has ≥1 here.
        await redis.zadd(momentKey, entries[0], ...entries.slice(1))
        recordsReindexed += entries.length
      }
    }
  } while (cursor !== '0')
  // Trim every touched moment key once at the end.
  await Promise.all(
    Array.from(touchedMomentKeys).map((k) =>
      redis.zremrangebyrank(k, 0, -MAX_PER_MOMENT - 1).catch(() => {}),
    ),
  )
  return { sendersScanned, recordsReindexed }
}
