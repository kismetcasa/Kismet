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

const keyBySender = (sender: string) =>
  `kismetart:airdrops:sender:${sender.toLowerCase()}`

/**
 * Append one (sender, recipient) pair to the sender's airdrop log.
 * Multi-recipient airdrops fan out to one row per recipient — same shape
 * inprocess returns, so the ProfileView renderer doesn't need to branch.
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
  await redis.zadd(keyBySender(sender), {
    score: timestamp,
    member: JSON.stringify(stored),
  })
  // Trim to MAX_PER_SENDER to bound storage; heaviest airdroppers will lose
  // the oldest entries first (acceptable for a "recent activity" view).
  await redis.zremrangebyrank(keyBySender(sender), 0, -MAX_PER_SENDER - 1)
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
 * Remove every airdrop row from `sender`'s log that matches the given
 * (collection, tokenId, recipient) tuple. Used by the admin "remove
 * entry" tool to undo a bad backfill — e.g., when an ENS lookup
 * resolved to a stale address and the entry needs to be retired before
 * the correct one is rewritten.
 *
 * Returns the count removed. Match is case-insensitive on every
 * address; tokenId is compared as a string to mirror how it was
 * normalized at write-time.
 */
export async function removeAirdropEntries(
  sender: string,
  match: { collectionAddress: string; tokenId: string; recipient: string },
): Promise<number> {
  const key = keyBySender(sender)
  const raws = (await redis.zrange(key, 0, -1)) as string[]
  const collectionLower = match.collectionAddress.toLowerCase()
  const tokenIdStr = String(match.tokenId)
  const recipientLower = match.recipient.toLowerCase()
  const toRemove: string[] = []
  for (const raw of raws) {
    try {
      const r = typeof raw === 'string'
        ? (JSON.parse(raw) as AirdropRecord)
        : (raw as AirdropRecord)
      if (
        r.collectionAddress?.toLowerCase() === collectionLower &&
        String(r.tokenId) === tokenIdStr &&
        r.recipient?.address?.toLowerCase() === recipientLower
      ) {
        toRemove.push(raw)
      }
    } catch {
      continue
    }
  }
  if (toRemove.length === 0) return 0
  // zrem accepts multiple members; cast to satisfy the generic typing
  // Upstash exposes (member, ...members) → (string | number, ...).
  await redis.zrem(key, ...(toRemove as [string, ...string[]]))
  return toRemove.length
}
