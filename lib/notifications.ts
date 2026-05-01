import { redis } from './redis'
import { isFollowing } from './follows'
import { randomUUID } from 'crypto'

export type NotificationType = 'collect' | 'sale' | 'follow' | 'mint' | 'listing_expired'

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
  listingId?: string
  comment?: string
}

export type NotificationInput = Omit<Notification, 'id' | 'timestamp' | 'priority' | 'read'>

const MAX_PER_USER = 200
const FOLLOW_DEDUP_WINDOW_SECS = 7 * 24 * 60 * 60
const READ_IDS_TTL_SECS = 30 * 24 * 60 * 60  // 30 days
const MUTED_TTL_SECS = 365 * 24 * 60 * 60     // 1 year

const keyNotif = (a: string) => `kismetart:notif:${a.toLowerCase()}`
const keyLastRead = (a: string) => `kismetart:notif-last-read:${a.toLowerCase()}`
const keyReadIds = (a: string) => `kismetart:notif-read-ids:${a.toLowerCase()}`
const keyMuted = (a: string) => `kismetart:notif-muted:${a.toLowerCase()}`
const KEY_PROFILES = 'kismetart:profiles'

export const keyMomentMeta = (addr: string, tokenId: string) =>
  `kismetart:moment-meta:${addr.toLowerCase()}:${tokenId}`

export interface MomentMeta {
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
  if (type === 'collect' && price && price !== '0') return true
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

export interface NotificationListOpts {
  tab?: 'priority' | 'all'
  type?: NotificationType
  limit?: number
  page?: number
}

export interface NotificationListResult {
  notifications: Notification[]
  total: number
  page: number
}

export async function getNotifications(
  address: string,
  opts: NotificationListOpts = {},
): Promise<NotificationListResult> {
  const { tab = 'all', type, limit = 20, page = 1 } = opts
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
      if (n.actor && muted.has(n.actor.toLowerCase())) continue
      if (tab === 'priority' && !n.priority) continue
      if (type && n.type !== type) continue
      const read = n.timestamp <= lastReadTs || readIds.has(n.id)
      all.push({ ...n, read })
    } catch {
      continue
    }
  }

  const total = all.length
  const start = (page - 1) * limit
  return { notifications: all.slice(start, start + limit), total, page }
}

export async function getUnreadCount(address: string): Promise<number> {
  const [raws, lastRead, readIdsArr] = await Promise.all([
    redis.zrange(keyNotif(address), 0, -1, { rev: true }) as Promise<string[]>,
    redis.get<string>(keyLastRead(address)),
    redis.smembers(keyReadIds(address)) as Promise<string[]>,
  ])
  const lastReadTs = Number(lastRead ?? 0)
  const readIds = new Set(readIdsArr)
  let count = 0
  for (const raw of raws) {
    try {
      const n = typeof raw === 'string' ? (JSON.parse(raw) as Notification) : (raw as Notification)
      if (!n.priority) continue
      if (n.timestamp <= lastReadTs) continue
      if (readIds.has(n.id)) continue
      count += 1
    } catch {
      continue
    }
  }
  return count
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
