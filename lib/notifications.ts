import { redis } from './redis'
import { isFollowing } from './follows'
import { randomUUID } from 'crypto'

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

type NotificationInput = Omit<Notification, 'id' | 'timestamp' | 'priority' | 'read'>

const MAX_PER_USER = 200
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
const KEY_PROFILES = 'kismetart:profiles'

const keyMomentMeta = (addr: string, tokenId: string) =>
  `kismetart:moment-meta:${addr.toLowerCase()}:${tokenId}`

interface MomentMeta {
  creator: string
  name?: string
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
        const muted = (await redis.smembers(keyMutedTypes(input.recipient))) as string[]
        if (muted.includes(input.type)) return
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

    const id = randomUUID()
    const timestamp = Math.floor(Date.now() / 1000)
    const priority = await isPriority(input.recipient, input.type, input.actor, input.price)
    const recipient = input.recipient.toLowerCase()
    const stored = {
      ...input,
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
  } catch {
    // Notifications are non-critical — never let them break the parent operation
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
async function loadAndAnnotate(address: string): Promise<Notification[]> {
  const [raws, lastRead, readIdsArr, mutedArr] = await Promise.all([
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

export async function getUnreadCount(address: string): Promise<number> {
  const all = await loadAndAnnotate(address)
  return all.reduce((acc, n) => acc + (n.priority && !n.read ? 1 : 0), 0)
}

export async function markAllRead(address: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await Promise.all([
    redis.set(keyLastRead(address), String(now)),
    redis.del(keyReadIds(address)),
  ])
}

export async function markOneRead(address: string, id: string): Promise<void> {
  await redis.sadd(keyReadIds(address), id)
  void redis.expire(keyReadIds(address), READ_IDS_TTL_SECS).catch(() => {})
}

export async function muteActor(address: string, actor: string): Promise<void> {
  await redis.sadd(keyMuted(address), actor.toLowerCase())
  void redis.expire(keyMuted(address), MUTED_TTL_SECS).catch(() => {})
}

export async function unmuteActor(address: string, actor: string): Promise<void> {
  await redis.srem(keyMuted(address), actor.toLowerCase())
}

export async function getMutedActors(address: string): Promise<string[]> {
  return (await redis.smembers(keyMuted(address))) as string[]
}

export async function muteType(address: string, type: NotificationType): Promise<void> {
  await redis.sadd(keyMutedTypes(address), type)
  void redis.expire(keyMutedTypes(address), MUTED_TTL_SECS).catch(() => {})
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

export async function setMomentMeta(
  contractAddress: string,
  tokenId: string,
  meta: MomentMeta,
): Promise<void> {
  await redis.set(keyMomentMeta(contractAddress, tokenId), JSON.stringify({
    creator: meta.creator.toLowerCase(),
    name: meta.name,
  }))
}
