import { redis } from './redis'

// Per-collector "what I've collected" ZSET. Written by /api/collect
// (direct mints) and /api/airdrop/notify (recipients); read by the
// timeline route's Collected tab. Centralized so the key shape and
// member format have a single source of truth.
const keyCollected = (collector: string) =>
  `kismetart:collected:${collector.toLowerCase()}`

const member = (collection: string, tokenId: string) =>
  `${collection.toLowerCase()}:${tokenId}`

// Per-ARTWORK collect log — the reverse of the per-collector zset above, one
// row per recorded collect (not per collector): who, when, which tx. Written
// by /api/collect next to the collector's zset; read by the artwork activity
// route (the moment comments proxy), which folds these rows into the activity
// list exactly the way it folds lib/airdrops' per-moment index. It exists because the activity list
// is otherwise sourced ONLY from In Process's comment feed, and that feed is
// built from the MintComment event — which Zora's sale strategies emit only
// for a NON-EMPTY comment. A mint with an empty comment (the agent / scout
// paths until 2026-09, any other client that leaves it blank) is a real sale
// Kismet recorded, ranked in latest-sales and counted in supply, with no row
// anywhere a viewer can see. Same shape/caps as lib/airdrops' moment index.
const keyCollectsByMoment = (collection: string, tokenId: string) =>
  `kismetart:collects:moment:${collection.toLowerCase()}:${String(tokenId)}`

// Newest 500 per artwork: far more than the activity panel folds (page 0
// only), bounds the zset on an open edition. Oldest rows fall off first.
const MAX_COLLECTS_PER_MOMENT = 500

export interface MomentCollectRecord {
  /** The wallet the edition was minted TO (lowercased) — the collector. */
  collector: string
  /** Canonical (lowercased) hash of the mint tx. */
  txHash: string
  /** Editions minted in this tx (the client's bounded claim, as recorded). */
  amount: number
  /** ms. The mint's BLOCK time when the record knew it, else the record time —
   *  either way the instant the activity row sorts on. */
  timestamp: number
  /** A human-written collect comment (the platform default is not stored). */
  comment?: string
  /** Proven payer of a gift mint, when it wasn't the collector. */
  giftedBy?: string
}

/**
 * The zset member for one collect, byte-for-byte deterministic for the same
 * (tx, collector): fixed key order, no volatile fields. That determinism is
 * load-bearing — a re-record of the same tx (a client retry past the
 * idempotency window, a re-run reconcile, a pasted record URL) ZADDs the
 * identical member and is a no-op instead of a duplicate activity row.
 */
export function momentCollectMember(record: MomentCollectRecord): string {
  const comment = record.comment?.trim()
  return JSON.stringify({
    collector: record.collector.toLowerCase(),
    txHash: record.txHash.toLowerCase(),
    amount: Math.max(1, Math.floor(record.amount) || 1),
    timestamp: Math.floor(record.timestamp),
    ...(comment ? { comment } : {}),
    ...(record.giftedBy ? { giftedBy: record.giftedBy.toLowerCase() } : {}),
  })
}

/** Parse a zrange reply of JSON members, skipping anything unrenderable. */
function parseMomentCollectRows(raws: unknown[]): MomentCollectRecord[] {
  const out: MomentCollectRecord[] = []
  for (const raw of raws) {
    try {
      const r = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Partial<MomentCollectRecord> | null
      if (!r || typeof r.collector !== 'string' || typeof r.txHash !== 'string') continue
      if (typeof r.timestamp !== 'number' || !Number.isFinite(r.timestamp)) continue
      out.push({
        collector: r.collector,
        txHash: r.txHash,
        amount: typeof r.amount === 'number' && r.amount > 0 ? r.amount : 1,
        timestamp: r.timestamp,
        ...(typeof r.comment === 'string' && r.comment ? { comment: r.comment } : {}),
        ...(typeof r.giftedBy === 'string' && r.giftedBy ? { giftedBy: r.giftedBy } : {}),
      })
    } catch {
      continue
    }
  }
  return out
}

/**
 * Append one verified collect to the artwork's log. Callers pass the block
 * time when they have it; the score is the row's timestamp so a late record
 * of an older mint lands in its true place, not at the top.
 */
export async function recordMomentCollect(
  collection: string,
  tokenId: string,
  record: MomentCollectRecord,
): Promise<void> {
  const key = keyCollectsByMoment(collection, tokenId)
  await redis.zadd(key, { score: Math.floor(record.timestamp), member: momentCollectMember(record) })
  await redis.zremrangebyrank(key, 0, -MAX_COLLECTS_PER_MOMENT - 1)
}

/**
 * The artwork's recorded collects, newest first. Empty on any error so the
 * comments route can fold it without a try/catch (mirrors getAirdropsByMoment).
 */
export async function getMomentCollects(
  collection: string,
  tokenId: string,
  opts: { limit?: number } = {},
): Promise<MomentCollectRecord[]> {
  const limit = Math.max(1, Math.min(MAX_COLLECTS_PER_MOMENT, opts.limit ?? 100))
  try {
    const raws = (await redis.zrange(keyCollectsByMoment(collection, tokenId), 0, limit - 1, {
      rev: true,
    })) as unknown[]
    return parseMomentCollectRows(raws)
  } catch {
    return []
  }
}

/** Delete a collector's entire collected ZSET. Admin profile-erase only.
 *  Re-derives only from NEW collects going forward (it's event-sourced,
 *  not chain-backfilled) — acceptable for erase targets, who have none. */
export async function deleteCollected(collector: string): Promise<void> {
  await redis.del(keyCollected(collector))
}

export async function recordCollected(
  collector: string,
  collection: string,
  tokenId: string,
  timestamp: number = Date.now(),
): Promise<void> {
  // GT: a newer acquisition of the same piece still floats it to the top of
  // the Collected tab (greater score wins), but a LATE record of an OLDER
  // mint — a replay past the idempotency window, a reconcile — can no longer
  // drag the piece backwards or, with a wall-clock score, fake a fresh
  // acquisition. GT never blocks a first insert.
  await redis.zadd(
    keyCollected(collector),
    { gt: true },
    { score: timestamp, member: member(collection, tokenId) },
  )
}

// Returns "<collection>:<tokenId>" tuples newest-first. Empty array on
// any error so callers can use it as a fallback list without try/catch.
export async function getCollectedMembers(collector: string): Promise<string[]> {
  try {
    return (await redis.zrange(keyCollected(collector), 0, -1, {
      rev: true,
    })) as string[]
  } catch {
    return []
  }
}

// Single-membership check (ZSCORE) — cheaper than fetching the whole set when
// you only need to know whether one ref was collected (e.g. validating a
// theme-source moment belongs to the owner). false on any error.
export async function isCollected(
  collector: string,
  collection: string,
  tokenId: string,
): Promise<boolean> {
  try {
    const score = await redis.zscore(keyCollected(collector), member(collection, tokenId))
    return score !== null && score !== undefined
  } catch {
    return false
  }
}
