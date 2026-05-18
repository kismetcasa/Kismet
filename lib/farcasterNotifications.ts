import { redis } from './redis'
import { getFarcasterProfileByAddress, getFarcasterProfileByFid } from './farcasterProfile'
import {
  ALL_NOTIFICATION_TYPES,
  isActorMuted,
  NON_MUTEABLE_TYPES,
  type Notification,
  type NotificationType,
} from './notifications'

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
const keyPushMaster = (fid: number) => `kismetart:fc:push-master:${fid}`
const keyIdempotency = (fid: number, notificationId: string) =>
  `kismetart:fc:notif-sent:${fid}:${notificationId}`

const IDEMPOTENCY_TTL_SECS = 24 * 60 * 60
const TOKENS_TTL_SECS = 365 * 24 * 60 * 60
const PUSH_TYPES_TTL_SECS = 365 * 24 * 60 * 60
const PUSH_MASTER_TTL_SECS = 365 * 24 * 60 * 60

// Master toggle: 'on' | 'off' | (absent = default off). Default-off is
// the conservative posture asked for in design — no surprise pushes.
// One narrow exception: on FIRST registration (notifications_enabled
// webhook with no prior token state), we set master='on' so the
// "Add Kismet for collect alerts" prompt actually delivers what it
// promised. Subsequent registrations preserve whatever the user has
// explicitly set in Kismet settings.
type MasterState = 'on' | 'off' | null

// On first notification grant, only 'collect' is on. Other types must be
// opted into explicitly via settings. Keeps the post-add experience
// matching what the prompt promised ("collect alerts").
const DEFAULT_ENABLED_PUSH_TYPES: ReadonlySet<NotificationType> = new Set(['collect'])

/**
 * Persist a notification token for an FID. Idempotent — duplicate (url, token)
 * pairs are stored once.
 *
 * First-registration seeding:
 *   - Per-type opt-in set: seeded with DEFAULT_ENABLED_PUSH_TYPES ({collect})
 *     so the prompt's "collect alerts" promise is honored.
 *   - Master toggle: set to 'on' ONLY when the FID has zero prior tokens AND
 *     no explicit master setting. After that, the user's Kismet-level
 *     master setting (if any) is respected through add/remove churn.
 */
export async function registerToken(fid: number, details: NotificationToken): Promise<void> {
  // Check first-registration state BEFORE the SADD that would change it.
  // SCARD on a missing key returns 0 — distinguishes truly-new from
  // existing-but-empty.
  let isFirstRegistration = false
  try {
    isFirstRegistration = (await redis.scard(keyTokens(fid))) === 0
  } catch {
    // If we can't tell, conservatively assume NOT a first registration
    // so we don't auto-enable master for an existing user on a hiccup.
    isFirstRegistration = false
  }

  const member = JSON.stringify({ url: details.url, token: details.token })
  await redis
    .multi()
    .sadd(keyTokens(fid), member)
    .expire(keyTokens(fid), TOKENS_TTL_SECS)
    .exec()

  if (!isFirstRegistration) return

  // Seed per-type defaults only when the user has nothing on record yet.
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

  // Auto-enable master on first registration only when the user has
  // never explicitly set it. Existing 'off' settings are preserved.
  try {
    const current = (await redis.get<string>(keyPushMaster(fid))) as MasterState
    if (current !== 'on' && current !== 'off') {
      await redis.set(keyPushMaster(fid), 'on', { ex: PUSH_MASTER_TTL_SECS })
    }
  } catch {
    // Non-critical — falls through to default-off, which the user can
    // flip on themselves in settings.
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

// ---------- Master toggle ----------

/** Read the user's master setting. Returns null when never set (= default off). */
export async function getPushMaster(fid: number): Promise<MasterState> {
  try {
    const v = (await redis.get<string>(keyPushMaster(fid))) as MasterState
    return v === 'on' || v === 'off' ? v : null
  } catch {
    return null
  }
}

/** Set the master toggle explicitly. Persists with a 1y TTL like the rest. */
export async function setPushMaster(fid: number, enabled: boolean): Promise<void> {
  await redis.set(keyPushMaster(fid), enabled ? 'on' : 'off', { ex: PUSH_MASTER_TTL_SECS })
}

/**
 * Effective master state for dispatch. Maps the tri-state into a boolean:
 *   on              → true
 *   off | null      → false  (null = never set = default off)
 *
 * The auto-enable in registerToken means a freshly-added user with no
 * settings churn will read 'on' here, so the prompt promise still works.
 */
async function isPushMasterOn(fid: number): Promise<boolean> {
  return (await getPushMaster(fid)) === 'on'
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

function formatPushPrice(price: string, currency?: 'eth' | 'usdc'): string {
  return currency === 'usdc' ? `$${price}` : `${price} ETH`
}

// Composition mirrors components/NotificationRow.tsx so the push and the
// in-app row read identically — including the actor-absent variants
// ("your moment was created", "your listing was filled", "an admin added
// you as creator"). When the row says one thing and the push says
// another, users feel like two notification systems rather than one.
async function compose(n: Notification): Promise<ComposedPush | null> {
  // Actor display name. NotificationRow falls back to the shortened
  // hex address; we match that, then fall back further to 'someone'
  // only when the actor field is genuinely absent (self-actions).
  let actorName: string | null = null
  if (n.actor) {
    try {
      const profile = await getFarcasterProfileByAddress(n.actor)
      actorName = actorLabel(profile?.displayName ?? null, profile?.username ?? null, n.actor)
    } catch {
      actorName = actorLabel(null, null, n.actor)
    }
  }

  const tokenName = n.tokenName?.trim() || null
  const momentUrl =
    n.tokenAddress && n.tokenId ? `${SITE_URL}/moment/${n.tokenAddress}/${n.tokenId}` : SITE_URL

  switch (n.type) {
    case 'collect': {
      const priceLabel = n.price && n.price !== '0'
        ? ` for ${formatPushPrice(n.price, n.currency)}`
        : ''
      const subject = tokenName ? `"${tokenName}"` : 'your moment'
      const who = actorName ?? 'someone'
      // Surface the buyer's optional comment so the push carries the
      // same context the in-app row does. The full-body truncate at
      // the end handles the case where comment + name + price overflow.
      const commentSuffix = n.comment?.trim() ? ` — "${n.comment.trim()}"` : ''
      return {
        title: truncate('New collect', TITLE_MAX),
        body: truncate(`${who} collected ${subject}${priceLabel}${commentSuffix}`, BODY_MAX),
        targetUrl: momentUrl,
      }
    }
    case 'sale': {
      const priceLabel = n.price ? ` for ${formatPushPrice(n.price, n.currency)}` : ''
      const subject = tokenName ?? 'untitled'
      return {
        title: truncate('Sale on Kismet', TITLE_MAX),
        body: truncate(
          actorName
            ? `${actorName} bought "${subject}"${priceLabel}`
            : `your listing was filled — "${subject}"${priceLabel}`,
          BODY_MAX,
        ),
        targetUrl: momentUrl,
      }
    }
    case 'mint': {
      // Self-mint confirmation (no actor) vs follower-fanout (actor set).
      // Matches NotificationRow's two branches exactly.
      if (!actorName) {
        return {
          title: truncate('Moment created', TITLE_MAX),
          body: truncate(
            tokenName ? `Your moment "${tokenName}" is live` : 'Your moment was created',
            BODY_MAX,
          ),
          targetUrl: momentUrl,
        }
      }
      return {
        title: truncate(`${actorName} minted`, TITLE_MAX),
        body: truncate(
          tokenName ? `${actorName} minted "${tokenName}"` : `${actorName} minted a new moment`,
          BODY_MAX,
        ),
        targetUrl: momentUrl,
      }
    }
    case 'airdrop': {
      const subject = tokenName ? `"${tokenName}"` : 'a moment'
      const who = actorName ?? 'someone'
      return {
        title: truncate('Airdrop received', TITLE_MAX),
        body: truncate(`${who} airdropped you ${subject}`, BODY_MAX),
        targetUrl: momentUrl,
      }
    }
    case 'follow':
      // Actor absent on follow would be a write-side bug — surface a
      // safe fallback rather than the awkward "someone followed you".
      return {
        title: truncate('New follower', TITLE_MAX),
        body: truncate(
          actorName ? `${actorName} followed you` : 'someone followed you',
          BODY_MAX,
        ),
        targetUrl: n.actor ? `${SITE_URL}/profile/${n.actor}` : SITE_URL,
      }
    case 'payout': {
      // In-app row links to the moment, not the profile — payouts are
      // moment-scoped (one split distribution per moment). Match that.
      const currencyLabel = (n.currency ?? 'eth').toUpperCase()
      const subject = tokenName ? `"${tokenName}"` : 'a moment'
      const amountLabel = n.price ? `${formatPushPrice(n.price, n.currency)} ` : ''
      return {
        title: truncate('Payout received', TITLE_MAX),
        body: truncate(
          `You received ${amountLabel}from ${subject} (${currencyLabel})`,
          BODY_MAX,
        ),
        targetUrl: momentUrl,
      }
    }
    case 'authorized': {
      const subject = tokenName ? `"${tokenName}"` : 'a collection'
      const who = actorName ?? 'an admin'
      return {
        title: truncate('Mint access granted', TITLE_MAX),
        body: truncate(`${who} added you as a creator on ${subject}`, BODY_MAX),
        targetUrl: n.tokenAddress ? `${SITE_URL}/collection/${n.tokenAddress}` : SITE_URL,
      }
    }
    case 'listing_created': {
      const subject = tokenName ? `"${tokenName}"` : 'a moment'
      const who = actorName ?? 'someone'
      const priceLabel = n.price ? ` for ${formatPushPrice(n.price, n.currency)}` : ''
      return {
        title: truncate('New listing', TITLE_MAX),
        body: truncate(`${who} listed ${subject}${priceLabel}`, BODY_MAX),
        targetUrl: momentUrl,
      }
    }
    case 'listing_expired': {
      const subject = tokenName ? `"${tokenName}"` : 'a moment'
      const priceLabel = n.price ? ` (${formatPushPrice(n.price, n.currency)})` : ''
      return {
        title: truncate('Listing expired', TITLE_MAX),
        body: truncate(`Your listing on ${subject} expired${priceLabel}`, BODY_MAX),
        targetUrl: momentUrl,
      }
    }
    default: {
      // Exhaustiveness — TS errors if NotificationType grows without a
      // new case here. Matches NotificationRow's same guard.
      const _exhaustive: never = n.type
      void _exhaustive
      return null
    }
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
 * Gates (in order — cheap-to-expensive, short-circuit on first fail):
 *   1. Recipient address present.
 *   2. Actor not muted by recipient (reconciles with the in-app
 *      muted-accounts list — muting silences both transports).
 *   3. Recipient has a Farcaster identity at all.
 *   4. Master push toggle is on (default off; auto-enabled on first
 *      registration so the "Add Kismet" prompt promise survives).
 *   5. Per-type opt-in includes this notification type.
 *   6. Recipient has at least one notification token.
 *   7. SETNX (fid, notificationId) idempotency key — survives webhook
 *      retries and any accidental duplicate dispatch from call sites.
 *
 * After all gates pass, the body is composed (mirrors NotificationRow's
 * copy so push and feed read identically), then POSTed to every distinct
 * host URL the FID has tokens for. Tokens the host reports as
 * `invalidTokens` are GC'd; `rateLimitedTokens` are left in place — the
 * host will accept them again after the limit window.
 */
export async function dispatchFarcasterPush(n: Notification): Promise<void> {
  try {
    if (!n.recipient) return

    // Actor-mute reconciliation: the in-app feed hides notifications
    // from muted actors at read time. If the user muted someone, we
    // should also suppress the FC push — otherwise muting in feed
    // leaves a louder transport untouched, breaking the user's
    // expectation that "mute X" silences X everywhere. Financial types
    // bypass actor-mute here for the same reason loadAndAnnotate does:
    // money-bearing events must reach the user regardless of mutes.
    // Address-keyed (matches muteActor/unmuteActor), not FID-keyed —
    // a user might mute another address that has no FC identity.
    if (
      n.actor &&
      !NON_MUTEABLE_TYPES.has(n.type) &&
      (await isActorMuted(n.recipient, n.actor))
    ) {
      return
    }

    const profile = await getFarcasterProfileByAddress(n.recipient)
    if (!profile) return

    const fid = profile.fid

    // Master toggle is the outermost FC-push gate. When off (or never
    // set, which is the default-off posture), no pushes fire regardless
    // of per-type opt-ins.
    if (!(await isPushMasterOn(fid))) return

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
