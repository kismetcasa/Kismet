import { redis } from './redis'
import { getFarcasterProfileByAddress, getFarcasterProfileByFid } from './farcasterProfile'
import { ALL_NOTIFICATION_TYPES, type Notification, type NotificationType } from './notifications'

// Farcaster native push notifications, layered on top of the in-app bell.
//
// When a user adds Kismet inside a Farcaster host, the host POSTs a
// JFS-signed webhook to /api/farcaster/webhook with a (token, url) pair.
// We store those tokens keyed by FID. Whenever writeNotification fires,
// we look up the recipient's FID, check whether they've opted-in to push
// for this notification type, and POST to the host's notification URL
// so the user receives a native FC push that opens the Mini App at the
// relevant page when tapped.
//
// Identity model:
//   - In-app bell is keyed by Ethereum address (existing behavior).
//   - FC push is keyed by FID. Address→FID via getFarcasterProfileByAddress.
//   - One FID can have multiple tokens (mobile FC + web FC = two clients
//     of the same user). We send to every token the FID has registered.
//
// Opt-in policy (per-type, persisted per-FID):
//   - On first registration (notifications_enabled webhook), we seed
//     the opt-in set with just {'collect'}. Everything else off by default.
//   - User can flip the rest on via the settings tab in NotificationModal.
//
// Failure model:
//   - This is non-critical infrastructure. Every entry point swallows
//     errors so a Farcaster API blip can never break a mint or a follow.

// ---------- Storage ----------

export interface NotificationToken {
  /** Host's notification endpoint — POST target. */
  url: string
  /** Opaque per-(fid, client) token issued by the host. */
  token: string
}

const keyTokens = (fid: number) => `kismetart:fc:tokens:${fid}`
const keyPushTypes = (fid: number) => `kismetart:fc:push-types:${fid}`
const keyIdempotency = (fid: number, notificationId: string) =>
  `kismetart:fc:notif-sent:${fid}:${notificationId}`

const IDEMPOTENCY_TTL_SECS = 24 * 60 * 60
const TOKENS_TTL_SECS = 365 * 24 * 60 * 60
const PUSH_TYPES_TTL_SECS = 365 * 24 * 60 * 60

// On first notification grant, only 'collect' is on. Other types must be
// opted into explicitly via settings. Keeps the post-add experience
// matching what the prompt promised ("collect alerts").
const DEFAULT_ENABLED_PUSH_TYPES: ReadonlySet<NotificationType> = new Set(['collect'])

/**
 * Persist a notification token for an FID. Idempotent — duplicate (url, token)
 * pairs are stored once. Seeds the per-type opt-in set with the default if
 * this is the FID's first token (i.e. they just added Kismet for the first
 * time).
 */
export async function registerToken(fid: number, details: NotificationToken): Promise<void> {
  const member = JSON.stringify({ url: details.url, token: details.token })
  await redis
    .multi()
    .sadd(keyTokens(fid), member)
    .expire(keyTokens(fid), TOKENS_TTL_SECS)
    .exec()

  // Seed defaults only if push-types set is empty (first registration).
  // Re-adds after a remove/add cycle should not re-seed — keep user prefs.
  try {
    const existing = await redis.scard(keyPushTypes(fid))
    if (existing === 0) {
      const defaults = [...DEFAULT_ENABLED_PUSH_TYPES]
      if (defaults.length > 0) {
        const [first, ...rest] = defaults
        await redis
          .multi()
          .sadd(keyPushTypes(fid), first, ...rest)
          .expire(keyPushTypes(fid), PUSH_TYPES_TTL_SECS)
          .exec()
      }
    }
  } catch {
    // Best-effort — if seed fails the user just has zero push types until
    // they toggle one on, which is a safe degradation.
  }
}

/** Drop a single token (host invalidated it, or remove webhook for a known token). */
export async function unregisterToken(fid: number, details: NotificationToken): Promise<void> {
  const member = JSON.stringify({ url: details.url, token: details.token })
  await redis.srem(keyTokens(fid), member)
}

/** Drop ALL tokens for an FID (miniapp_removed or notifications_disabled). */
export async function clearTokens(fid: number): Promise<void> {
  await redis.del(keyTokens(fid))
}

export async function getTokens(fid: number): Promise<NotificationToken[]> {
  let raws: string[] = []
  try {
    raws = (await redis.smembers(keyTokens(fid))) as string[]
  } catch {
    return []
  }
  const out: NotificationToken[] = []
  for (const raw of raws) {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (parsed?.url && parsed?.token) out.push({ url: parsed.url, token: parsed.token })
    } catch {
      // Drop corrupt entries silently.
    }
  }
  return out
}

// ---------- Per-type opt-in ----------

export async function getEnabledPushTypes(fid: number): Promise<NotificationType[]> {
  try {
    const arr = (await redis.smembers(keyPushTypes(fid))) as string[]
    return arr.filter((t): t is NotificationType =>
      (ALL_NOTIFICATION_TYPES as readonly string[]).includes(t),
    )
  } catch {
    return []
  }
}

export async function setPushTypeEnabled(
  fid: number,
  type: NotificationType,
  enabled: boolean,
): Promise<void> {
  if (enabled) {
    await redis
      .multi()
      .sadd(keyPushTypes(fid), type)
      .expire(keyPushTypes(fid), PUSH_TYPES_TTL_SECS)
      .exec()
  } else {
    await redis.srem(keyPushTypes(fid), type)
  }
}

async function isPushTypeEnabled(fid: number, type: NotificationType): Promise<boolean> {
  try {
    return (await redis.sismember(keyPushTypes(fid), type)) === 1
  } catch {
    return false
  }
}

// ---------- Composition ----------

// FC notification spec caps: title 32 chars, body 128 chars. We compose
// these conservatively to leave room for emoji-width quirks across clients.
const TITLE_MAX = 32
const BODY_MAX = 128
const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://kismet.art').replace(/\/$/, '')

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  // Leave 1 char for the ellipsis.
  return s.slice(0, Math.max(0, max - 1)) + '…'
}

function actorLabel(displayName: string | null, username: string | null, addr?: string): string {
  if (displayName?.trim()) return displayName.trim()
  if (username?.trim()) return `@${username.trim()}`
  if (addr) return `${addr.slice(0, 6)}…${addr.slice(-4)}`
  return 'someone'
}

interface ComposedPush {
  title: string
  body: string
  targetUrl: string
}

async function compose(n: Notification): Promise<ComposedPush | null> {
  // Look up actor display name when applicable. Web users without FC
  // profile fall back to short-hex; we never block on this.
  let actorName = 'someone'
  if (n.actor) {
    try {
      const profile = await getFarcasterProfileByAddress(n.actor)
      actorName = actorLabel(profile?.displayName ?? null, profile?.username ?? null, n.actor)
    } catch {
      actorName = actorLabel(null, null, n.actor)
    }
  }

  const tokenName = n.tokenName?.trim() || 'a piece'
  const momentUrl =
    n.tokenAddress && n.tokenId ? `${SITE_URL}/moment/${n.tokenAddress}/${n.tokenId}` : SITE_URL

  switch (n.type) {
    case 'collect': {
      const priceLabel = n.price && n.price !== '0'
        ? n.currency === 'usdc' ? ` for $${n.price}` : ` for ${n.price} ETH`
        : ''
      return {
        title: truncate('New collect', TITLE_MAX),
        body: truncate(`${actorName} collected "${tokenName}"${priceLabel}`, BODY_MAX),
        targetUrl: momentUrl,
      }
    }
    case 'sale': {
      const priceLabel = n.price
        ? n.currency === 'usdc' ? ` for $${n.price}` : ` for ${n.price} ETH`
        : ''
      return {
        title: truncate('Sale on Kismet', TITLE_MAX),
        body: truncate(`${actorName} bought "${tokenName}"${priceLabel}`, BODY_MAX),
        targetUrl: momentUrl,
      }
    }
    case 'mint':
      return {
        title: truncate(`New mint from ${actorName}`, TITLE_MAX),
        body: truncate(`${actorName} minted "${tokenName}"`, BODY_MAX),
        targetUrl: momentUrl,
      }
    case 'airdrop':
      return {
        title: truncate('You got an airdrop', TITLE_MAX),
        body: truncate(`${actorName} sent you "${tokenName}"`, BODY_MAX),
        targetUrl: momentUrl,
      }
    case 'follow':
      return {
        title: truncate('New follower', TITLE_MAX),
        body: truncate(`${actorName} followed you`, BODY_MAX),
        targetUrl: n.actor ? `${SITE_URL}/profile/${n.actor}` : SITE_URL,
      }
    case 'payout': {
      const priceLabel = n.price
        ? n.currency === 'usdc' ? `$${n.price}` : `${n.price} ETH`
        : 'a payout'
      return {
        title: truncate('Payout received', TITLE_MAX),
        body: truncate(`You received ${priceLabel}`, BODY_MAX),
        targetUrl: `${SITE_URL}/profile/${n.recipient}`,
      }
    }
    case 'authorized':
      return {
        title: truncate('Mint access granted', TITLE_MAX),
        body: truncate(`${actorName} gave you mint access on "${tokenName}"`, BODY_MAX),
        targetUrl: n.tokenAddress ? `${SITE_URL}/collection/${n.tokenAddress}` : SITE_URL,
      }
    case 'listing_created':
      return {
        title: truncate('New listing', TITLE_MAX),
        body: truncate(`${actorName} listed "${tokenName}"`, BODY_MAX),
        targetUrl: momentUrl,
      }
    case 'listing_expired':
      return {
        title: truncate('Listing expired', TITLE_MAX),
        body: truncate(`Your listing on "${tokenName}" expired`, BODY_MAX),
        targetUrl: momentUrl,
      }
    default:
      return null
  }
}

// ---------- Dispatch ----------

interface HostResponse {
  result?: {
    successfulTokens?: string[]
    invalidTokens?: string[]
    rateLimitedTokens?: string[]
  }
}

async function sendOne(
  url: string,
  tokens: string[],
  notificationId: string,
  title: string,
  body: string,
  targetUrl: string,
): Promise<HostResponse | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notificationId, title, body, targetUrl, tokens }),
    })
    if (!res.ok) return null
    return (await res.json()) as HostResponse
  } catch {
    return null
  }
}

/**
 * Fire-and-forget dispatch. Called by writeNotification after the Redis
 * write succeeds. Never throws — Farcaster push is a parallel transport,
 * the in-app bell is always authoritative.
 *
 * Lifecycle per call:
 *   1. Resolve recipient address → FID (fast, cached).
 *   2. Check user's per-type opt-in (skip if off).
 *   3. SETNX an idempotency key (skip if duplicate within 24h).
 *   4. POST to every distinct host URL the FID has tokens for, batching
 *      the tokens for that URL into a single call (the host accepts
 *      arrays per the spec).
 *   5. Drop any tokens the host reports as `invalidTokens` so we stop
 *      sending to them. `rateLimitedTokens` are left in place — the host
 *      will accept them again after the limit window.
 */
export async function dispatchFarcasterPush(n: Notification): Promise<void> {
  try {
    if (!n.recipient) return

    const profile = await getFarcasterProfileByAddress(n.recipient)
    if (!profile) return

    const fid = profile.fid

    if (!(await isPushTypeEnabled(fid, n.type))) return

    const tokens = await getTokens(fid)
    if (tokens.length === 0) return

    // (fid, notificationId) idempotency — survives webhook retries and any
    // accidental duplicate dispatch from writeNotification call sites.
    const idemKey = keyIdempotency(fid, n.id)
    const acquired = await redis.set(idemKey, '1', { nx: true, ex: IDEMPOTENCY_TTL_SECS })
    if (acquired !== 'OK') return

    const composed = await compose(n)
    if (!composed) return

    // Group tokens by URL so we issue one POST per host even when the FID
    // has multiple tokens on the same client.
    const byUrl = new Map<string, string[]>()
    for (const t of tokens) {
      const list = byUrl.get(t.url) ?? []
      list.push(t.token)
      byUrl.set(t.url, list)
    }

    await Promise.all(
      [...byUrl.entries()].map(async ([url, urlTokens]) => {
        const result = await sendOne(
          url,
          urlTokens,
          n.id,
          composed.title,
          composed.body,
          composed.targetUrl,
        )
        if (!result?.result?.invalidTokens?.length) return
        // Garbage-collect tokens the host rejected. Match by (url, token)
        // so a token revoked on one client doesn't drop the same string
        // if it happens to be reused on another (shouldn't happen, but
        // tokens are opaque so we don't assume).
        await Promise.all(
          result.result.invalidTokens.map((tok) => unregisterToken(fid, { url, token: tok })),
        )
      }),
    )
  } catch {
    // Push is non-critical infrastructure — never let it surface errors.
  }
}

// ---------- Helpers for the settings UI ----------

/**
 * Resolve the FID for a Kismet address, prefering the cached value. Used
 * by /api/notifications/push-types to gate setting persistence on the
 * caller having a real FC identity.
 */
export async function getFidForAddress(address: string): Promise<number | null> {
  try {
    const profile = await getFarcasterProfileByAddress(address)
    return profile?.fid ?? null
  } catch {
    return null
  }
}

/** Used by the settings UI to render "you have push enabled on Kismet" hints. */
export async function hasAnyToken(fid: number): Promise<boolean> {
  try {
    return (await redis.scard(keyTokens(fid))) > 0
  } catch {
    return false
  }
}

// Re-export to keep imports tidy at call sites.
export { getFarcasterProfileByFid }
