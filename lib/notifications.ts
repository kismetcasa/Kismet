import { redis } from './redis'
import { getFollowers, isFollowing } from './follows'
import { KEY_PROFILES } from './profile'
import { safeRead } from './redisRead'

export const ALL_NOTIFICATION_TYPES = [
  'collect',
  'sale',
  'follow',
  'mint',
  'listing_expired',
  'listing_created',
  'airdrop',
  'payout',
  'authorized',
  'agent_collect',
] as const

export type NotificationType = (typeof ALL_NOTIFICATION_TYPES)[number]

// Money-bearing types bypass actor-mute at read time and per-type mute at
// write time. Muting payouts is a footgun, not a preference.
export const NON_MUTEABLE_TYPES: ReadonlySet<NotificationType> = new Set([
  'sale',
  'airdrop',
  'payout',
])

export const MUTEABLE_TYPES: readonly NotificationType[] =
  ALL_NOTIFICATION_TYPES.filter((t) => !NON_MUTEABLE_TYPES.has(t))

export interface Notification {
  id: string
  type: NotificationType
  recipient: string
  timestamp: number
  priority: boolean
  read: boolean // computed at read time, never persisted
  actor?: string
  tokenAddress?: string
  tokenId?: string
  tokenName?: string
  tokenImage?: string
  amount?: number
  price?: string
  currency?: 'eth' | 'usdc' // for $ vs ETH formatting; absent on legacy notifs
  listingId?: string
  comment?: string
}

type NotificationInput = Omit<Notification, 'id' | 'timestamp' | 'priority' | 'read'> & {
  /** Internal — skip the isFollowing + isKnown Redis check in isPriority.
   *  Only set by fanoutToFollowers where recipients are proven followers
   *  of the actor, so isPriority always returns true. */
  _forcePriority?: true
}

const MAX_PER_USER = 200
// Notifications older than this are dropped lazily on each loadAndAnnotate
// call (see the ZREMRANGEBYSCORE prepended below). Replaces the previous
// per-5min background sweep that walked every profile in KEY_PROFILES —
// (1+N) commands per tick scaled linearly with total wallets ever connected.
const NOTIF_TTL_SECONDS = 60 * 24 * 60 * 60   // 60 days
const FOLLOW_DEDUP_WINDOW_SECS = 7 * 24 * 60 * 60
// Coalesces same-shape bursts (collect-all firing Promise.all-style, or a
// seller listing several editions back-to-back) into one notification per
// (recipient, actor, tokenAddress) tuple. 60s preserves distinct events
// over time while absorbing single-click bursts.
const BURST_DEDUP_WINDOW_SECS = 60
const BURST_DEDUP_TYPES: ReadonlySet<NotificationType> = new Set([
  'collect',
  'listing_created',
])
const READ_IDS_TTL_SECS = 30 * 24 * 60 * 60  // 30 days
const MUTED_TTL_SECS = 365 * 24 * 60 * 60     // 1 year

const keyNotif = (a: string) => `kismetart:notif:${a.toLowerCase()}`
const keyLastRead = (a: string) => `kismetart:notif-last-read:${a.toLowerCase()}`
const keyReadIds = (a: string) => `kismetart:notif-read-ids:${a.toLowerCase()}`
const keyMuted = (a: string) => `kismetart:notif-muted:${a.toLowerCase()}`
const keyMutedTypes = (a: string) => `kismetart:notif-muted-types:${a.toLowerCase()}`
const keyUnreadCount = (a: string) => `kismetart:notif-unread-count:${a.toLowerCase()}`

/**
 * Delete an address's entire notification footprint — inbox, read
 * markers, mute prefs, unread-count cache. Admin profile-erase only.
 * Note: notifications this address SENT into OTHER users' inboxes are left
 * as-is (purging them would scan every user's list); they render the actor
 * as a short address, which is the erased state anyway.
 */
export async function deleteNotificationData(address: string): Promise<void> {
  const a = address.toLowerCase()
  await Promise.all([
    redis.del(keyNotif(a)),
    redis.del(keyLastRead(a)),
    redis.del(keyReadIds(a)),
    redis.del(keyMuted(a)),
    redis.del(keyMutedTypes(a)),
    redis.del(keyUnreadCount(a)),
  ])
}

// Cache window for the precomputed unread count. Every path that can change
// the priority-unread count (priority writeNotification, markAllRead,
// markOneRead) calls invalidateUnreadCount which DELs this key immediately,
// so badge accuracy for all meaningful state changes is instant.
//
// The TTL is a safety net for one narrow edge: a priority notification that
// was never read and expires via ZREMRANGEBYSCORE after NOTIF_TTL_SECONDS
// (60 days). In that case the badge could show a stale +1 for up to TTL
// seconds before self-correcting. At 3600s that's a 1-hour phantom badge on
// a 60-day-old unread priority notification — an acceptable tradeoff given
// that opening the bell (getNotifications → loadAndAnnotate) cleans it up
// immediately. Non-priority writes never enter the count and are unaffected.
const UNREAD_COUNT_CACHE_TTL_SECS = 3600

const keyMomentMeta = (addr: string, tokenId: string) =>
  `kismetart:moment-meta:${addr.toLowerCase()}:${tokenId}`

interface MomentMeta {
  creator: string
  name?: string
  // Video duration in whole seconds, captured client-side at mint time
  // via FFprobe. Read by /api/timeline + surfaced as moment.kismet_duration_sec
  // so InlineVideo can pick the long-form preload strategy at
  // element-create time instead of waiting for loadedmetadata.
  durationSec?: number
}

async function isPriority(
  recipient: string,
  type: NotificationType,
  actor?: string,
  price?: string,
): Promise<boolean> {
  if (type === 'sale') return true
  if (type === 'mint') return true
  if (type === 'listing_expired') return true
  if (type === 'airdrop') return true
  if (type === 'payout') return true
  if (type === 'authorized') return true
  if (type === 'follow') return true
  // The user's own agent autonomously spent their funds — a money-bearing event
  // they should see immediately (like sale/payout), and on the server-side drop
  // coordinator path this notification is the ONLY signal. Kept muteable (not in
  // NON_MUTEABLE_TYPES) like `collect`, so the bell badges it but it can be muted.
  if (type === 'agent_collect') return true
  if (type === 'collect' && price && price !== '0') return true
  // listing_created stays non-priority — active sellers shouldn't dominate
  // the priority bell. The "all" tab still surfaces it for engaged followers.
  if (!actor) return false

  const [following, isKnown] = await Promise.all([
    isFollowing(recipient, actor),
    redis.sismember(KEY_PROFILES, actor.toLowerCase()).then((r) => r === 1),
  ])
  return following || isKnown
}

export async function writeNotification(input: NotificationInput): Promise<void> {
  try {
    if (input.actor && input.actor.toLowerCase() === input.recipient.toLowerCase()) return

    // Per-type mute — financial types bypass (see NON_MUTEABLE_TYPES).
    if (!NON_MUTEABLE_TYPES.has(input.type)) {
      try {
        if ((await redis.sismember(keyMutedTypes(input.recipient), input.type)) === 1) return
      } catch {}
    }

    if (input.type === 'follow' && input.actor) {
      const cutoff = Math.floor(Date.now() / 1000) - FOLLOW_DEDUP_WINDOW_SECS
      const recent = (await redis.zrange(keyNotif(input.recipient), cutoff, '+inf', {
        byScore: true,
      })) as string[]
      const dup = recent.some((raw) => {
        try {
          const n = JSON.parse(raw) as Notification
          return n.type === 'follow' && n.actor?.toLowerCase() === input.actor!.toLowerCase()
        } catch {
          return false
        }
      })
      if (dup) return
    }

    // Atomic SET NX lock keyed by (type, recipient, actor, tokenAddress).
    // Best-effort: a Redis transient lets the write through rather than
    // silently drop — a duplicate is preferable to a missed signal.
    if (BURST_DEDUP_TYPES.has(input.type) && input.actor && input.tokenAddress) {
      const lockKey = `kismetart:${input.type}-notif-lock:${input.recipient.toLowerCase()}:${input.actor.toLowerCase()}:${input.tokenAddress.toLowerCase()}`
      let acquired = true
      try {
        acquired = (await redis.set(lockKey, '1', { nx: true, ex: BURST_DEDUP_WINDOW_SECS })) === 'OK'
      } catch {}
      if (!acquired) return
    }

    const id = crypto.randomUUID()
    const timestamp = Math.floor(Date.now() / 1000)
    const priority = input._forcePriority || await isPriority(input.recipient, input.type, input.actor, input.price)
    const recipient = input.recipient.toLowerCase()
    // Strip the internal routing field before persisting — _forcePriority
    // is a call-site hint, not notification data.
    const { _forcePriority: _, ...inputData } = input
    const stored = {
      ...inputData,
      id,
      timestamp,
      priority,
      recipient,
      actor: input.actor?.toLowerCase(),
    }

    await redis.zadd(keyNotif(recipient), {
      score: timestamp,
      member: JSON.stringify(stored),
    })
    await redis.zremrangebyrank(keyNotif(recipient), 0, -MAX_PER_USER - 1)

    // Invalidate the precomputed unread count so the next bell poll
    // recomputes. Only matters for priority notifications (non-priority
    // never enter the count), so we skip the DEL for non-priority writes
    // to keep the steady-state Redis traffic minimal.
    if (priority) {
      void invalidateUnreadCount(recipient)
    }

    // Parallel transport: Farcaster native push. Imported lazily so the
    // non-FC code path (writes purely to the in-app bell) never pulls
    // farcasterProfile + the FC dispatch helpers into its module graph.
    // Lazy import also breaks the would-be circular dep between this
    // file and lib/farcasterNotifications (which imports our types).
    // Fire-and-forget — push is non-critical; the in-app bell already
    // succeeded above so the user will see it next time they open Kismet.
    void import('./farcasterNotifications')
      // `read` is a read-time computed field, never stored on the entry —
      // dispatch only cares about identity + payload fields, so the
      // false here is purely to satisfy the Notification type contract.
      .then(({ dispatchFarcasterPush }) => dispatchFarcasterPush({ ...stored, read: false }))
      .catch(() => {})
  } catch {
    // Notifications are non-critical — never let them break the parent operation
  }
}

// Write a notification to every follower of `source`, with actor=source.
// writeNotification's self-check filters source==follower; burst dedup runs
// inside writeNotification too. Callers should schedule via `after()` so
// the fan-out survives the response.
export async function fanoutToFollowers(
  source: string,
  payload: Omit<NotificationInput, 'recipient' | 'actor'>,
): Promise<void> {
  try {
    const followers = await getFollowers(source)
    await Promise.all(
      followers.map((follower) =>
        // _forcePriority: recipients are proven followers of source, so
        // isPriority always returns true via the isFollowing branch. Skip
        // the 2 Redis calls (isFollowing SISMEMBER + KEY_PROFILES SISMEMBER)
        // that would otherwise fire per recipient for collect/listing_created.
        writeNotification({ ...payload, recipient: follower, actor: source, _forcePriority: true }),
      ),
    )
  } catch {
    // notifications are non-critical
  }
}

interface NotificationListOpts {
  tab?: 'priority' | 'all'
  type?: NotificationType
  limit?: number
  page?: number
}

interface NotificationListResult {
  notifications: Notification[]
  total: number
  page: number
}

// Loads every stored notification for `address`, parses each entry, drops
// muted-actor rows, and stamps a computed `read` flag. Shared by the list +
// unread-count callers so the parse/mute/read invariants stay in sync.
//
// The leading ZREMRANGEBYSCORE drops entries older than NOTIF_TTL_SECONDS
// on every read — lazy cleanup that replaces a per-5min background sweep
// across every profile in KEY_PROFILES. Pattern: BullMQ's
// `removeOnComplete` lazy-removal. The result is discarded (the count of
// removed entries is uninteresting to callers); the cleanup completes
// before the ZRANGE in actual execution because Promise.all preserves
// command order on the wire for ordered SDKs, and worst case (cleanup
// happens after read) the stale entries are returned once and dropped
// next call — no correctness impact, just a one-poll display lag.
async function loadAndAnnotate(address: string): Promise<Notification[]> {
  const cutoff = Math.floor(Date.now() / 1000) - NOTIF_TTL_SECONDS
  const [, raws, lastRead, readIdsArr, mutedArr] = await Promise.all([
    redis.zremrangebyscore(keyNotif(address), 0, cutoff).catch(() => 0),
    redis.zrange(keyNotif(address), 0, -1, { rev: true }) as Promise<string[]>,
    redis.get<string>(keyLastRead(address)),
    redis.smembers(keyReadIds(address)) as Promise<string[]>,
    redis.smembers(keyMuted(address)) as Promise<string[]>,
  ])
  const lastReadTs = Number(lastRead ?? 0)
  const readIds = new Set(readIdsArr)
  const muted = new Set(mutedArr.map((a) => a.toLowerCase()))
  const all: Notification[] = []
  for (const raw of raws) {
    try {
      const n = typeof raw === 'string' ? (JSON.parse(raw) as Notification) : (raw as Notification)
      // Money-bearing types bypass actor-mute (see NON_MUTEABLE_TYPES).
      if (n.actor && muted.has(n.actor.toLowerCase()) && !NON_MUTEABLE_TYPES.has(n.type)) continue
      const read = n.timestamp <= lastReadTs || readIds.has(n.id)
      all.push({ ...n, read })
    } catch {
      continue
    }
  }
  return all
}

export async function getNotifications(
  address: string,
  opts: NotificationListOpts = {},
): Promise<NotificationListResult> {
  const { tab = 'all', type, limit = 20, page = 1 } = opts
  const all = (await loadAndAnnotate(address)).filter(
    (n) => (tab !== 'priority' || n.priority) && (!type || n.type === type),
  )
  const total = all.length
  const start = (page - 1) * limit
  return { notifications: all.slice(start, start + limit), total, page }
}

// Source-of-truth count: walks every notification and counts priority+unread.
// Expensive (1 ZRANGE + 1 GET + 2 SMEMBERS = 4 Redis ops); use getUnreadCountCached
// from the polling path. Still exported so admin/debug surfaces can force a recount.
export async function getUnreadCount(address: string): Promise<number> {
  const all = await loadAndAnnotate(address)
  return all.reduce((acc, n) => acc + (n.priority && !n.read ? 1 : 0), 0)
}

// Cache-aside read used by the notification-bell poll path. Most polls now
// hit the cache (1 GET); the expensive 4-op recompute only fires on cache
// miss after invalidation or TTL expiry. This replaces the prior pattern
// where every 30s poll re-walked every notification. See lib/redisRead for
// the failure semantics (safeRead returns the fallback null on Redis failure,
// which forces a recompute — no stale-empty trap).
export async function getUnreadCountCached(address: string): Promise<number> {
  const cached = await safeRead(
    'notif-unread-count-get',
    () => redis.get<number>(keyUnreadCount(address)),
    null,
  )
  if (typeof cached === 'number') return cached
  const count = await getUnreadCount(address)
  await safeRead(
    'notif-unread-count-set',
    () => redis.set(keyUnreadCount(address), count, { ex: UNREAD_COUNT_CACHE_TTL_SECS }),
    undefined,
  )
  return count
}

// Invalidate the cached count for `address`. Called from every priority
// write + every read-marking path so the next poll recomputes from source.
// Best-effort: a DEL failure just means the next poll reads a slightly
// stale value for up to UNREAD_COUNT_CACHE_TTL_SECS.
export async function invalidateUnreadCount(address: string): Promise<void> {
  await safeRead('notif-unread-count-del', () => redis.del(keyUnreadCount(address)), undefined)
}

export async function markAllRead(address: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await Promise.all([
    redis.set(keyLastRead(address), String(now)),
    redis.del(keyReadIds(address)),
  ])
  void invalidateUnreadCount(address)
}

// SADD+EXPIRE in MULTI/EXEC so a dropped EXPIRE can't leave the key
// TTL-less. Sliding TTL is intentional — active users keep their
// read/mute state warm.
export async function markOneRead(address: string, id: string): Promise<void> {
  await redis
    .multi()
    .sadd(keyReadIds(address), id)
    .expire(keyReadIds(address), READ_IDS_TTL_SECS)
    .exec()
  // The marked-read notification might have been priority — invalidate so
  // the next poll recomputes. False positive (non-priority notif marked
  // read) just causes one extra recompute; cheaper than tracking priority
  // per id here.
  void invalidateUnreadCount(address)
}

/**
 * True iff `address` has muted `actor`. Used by dispatchFarcasterPush
 * so muting in the feed also blocks FC push — the user perceives one
 * mute setting, not two. Key shape stays internal to this module so
 * callers can't drift from the storage helpers above.
 */
export async function isActorMuted(address: string, actor: string): Promise<boolean> {
  try {
    return (await redis.sismember(keyMuted(address), actor.toLowerCase())) === 1
  } catch {
    return false
  }
}

export async function muteActor(address: string, actor: string): Promise<void> {
  await redis
    .multi()
    .sadd(keyMuted(address), actor.toLowerCase())
    .expire(keyMuted(address), MUTED_TTL_SECS)
    .exec()
}

export async function unmuteActor(address: string, actor: string): Promise<void> {
  await redis.srem(keyMuted(address), actor.toLowerCase())
}

export async function getMutedActors(address: string): Promise<string[]> {
  return (await redis.smembers(keyMuted(address))) as string[]
}

export async function muteType(address: string, type: NotificationType): Promise<void> {
  await redis
    .multi()
    .sadd(keyMutedTypes(address), type)
    .expire(keyMutedTypes(address), MUTED_TTL_SECS)
    .exec()
}

export async function unmuteType(address: string, type: NotificationType): Promise<void> {
  await redis.srem(keyMutedTypes(address), type)
}

export async function getMutedTypes(address: string): Promise<NotificationType[]> {
  return (await redis.smembers(keyMutedTypes(address))) as NotificationType[]
}

export async function getMomentMeta(
  contractAddress: string,
  tokenId: string,
): Promise<MomentMeta | null> {
  const raw = await redis.get<string | MomentMeta>(keyMomentMeta(contractAddress, tokenId))
  if (!raw) return null
  return typeof raw === 'string' ? JSON.parse(raw) : raw
}

/**
 * Bulk fetch of moment-meta records. One MGET in place of N parallel GETs.
 * Returns the same index-aligned `(MomentMeta | null)[]` Promise.all would
 * have produced — null where the pair is invalid, the key is missing, or
 * the stored JSON is corrupt; null for every entry on MGET failure (matches
 * the prior per-call `.catch(() => null)` shape).
 */
export async function getMomentMetaBatch(
  pairs: { address?: string; tokenId?: string }[],
): Promise<(MomentMeta | null)[]> {
  const out: (MomentMeta | null)[] = pairs.map(() => null)
  if (pairs.length === 0) return out

  // Compact the valid pairs into a parallel array of keys so MGET only sees
  // well-formed inputs. The `compactIdx` lookup table re-aligns results
  // back to the original positions.
  const compactKeys: string[] = []
  const compactIdx: number[] = []
  for (let i = 0; i < pairs.length; i++) {
    const { address, tokenId } = pairs[i]
    if (!address || !tokenId) continue
    compactIdx.push(i)
    compactKeys.push(keyMomentMeta(address, tokenId))
  }
  if (compactKeys.length === 0) return out

  // Chunked MGET: callers pass batches that scale with feed fan-out (the
  // timeline stitch sends its whole merged set), and Upstash rejects any
  // single REST request over 10MB ("ERR max request size exceeded"). 512
  // keys/chunk keeps each request ~35KB — two orders of magnitude under the
  // cap — and auto-pipelining (lib/redis.ts) still collapses all chunks into
  // ONE HTTP round trip, so latency and billed commands are unchanged.
  const MGET_CHUNK = 512
  let raws: (string | MomentMeta | null)[]
  try {
    const chunks: string[][] = []
    for (let i = 0; i < compactKeys.length; i += MGET_CHUNK) {
      chunks.push(compactKeys.slice(i, i + MGET_CHUNK))
    }
    const results = await Promise.all(
      chunks.map((c) => redis.mget<(string | MomentMeta | null)[]>(...c)),
    )
    raws = results.flat()
  } catch {
    return out
  }
  for (let j = 0; j < compactIdx.length; j++) {
    const raw = raws[j]
    if (!raw) continue
    try {
      out[compactIdx[j]] = typeof raw === 'string' ? (JSON.parse(raw) as MomentMeta) : raw
    } catch {
      // Leave null — a single corrupt entry shouldn't poison the page.
    }
  }
  return out
}

export async function setMomentMeta(
  contractAddress: string,
  tokenId: string,
  meta: MomentMeta,
): Promise<void> {
  const key = keyMomentMeta(contractAddress, tokenId)
  // MERGE, don't clobber. `creator` is written once at mint and is the
  // authorization + attribution key: /api/moment/hide gates on it, and
  // statsMath.resolveMomentCreator treats it as highest precedence for
  // mint-count + earnings. A later metadata edit (/api/moment/update-uri,
  // authorized on METADATA|ADMIN — a broader set than the minter) must refresh
  // the display name WITHOUT reassigning attribution, so preserve an
  // already-established creator and only take the incoming one on first write.
  let existing: MomentMeta | null = null
  try {
    const raw = await redis.get<string | MomentMeta>(key)
    existing = raw ? (typeof raw === 'string' ? (JSON.parse(raw) as MomentMeta) : raw) : null
  } catch {
    // Unreadable/corrupt prior value → first-write semantics.
  }
  const creator = (existing?.creator ?? meta.creator).toLowerCase()
  const name = meta.name ?? existing?.name
  const durationSec =
    typeof meta.durationSec === 'number' && meta.durationSec > 0
      ? Math.round(meta.durationSec)
      : existing?.durationSec
  await redis.set(
    key,
    JSON.stringify({
      creator,
      name,
      ...(typeof durationSec === 'number' && durationSec > 0 ? { durationSec } : {}),
    }),
  )
}
