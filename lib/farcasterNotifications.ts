import { redis } from './redis'
import { acquireLock } from './redisLock'
import { getFarcasterProfileByAddress } from './farcasterProfile'
import { formatPrice, isPlatformCollectComment } from './inprocess'
import {
  ACTOR_MUTE_EXEMPT_TYPES,
  ALL_NOTIFICATION_TYPES,
  isActorMuted,
  type Notification,
  type NotificationType,
} from './notifications'
import { SITE_URL } from './siteUrl'
import { isSafePublicHttpsUrl } from './safeUrl'

// Farcaster native push notifications, layered on top of the in-app bell.
//
// When a user adds Kismet inside a Farcaster host (or enables notifications
// for it later), the host POSTs a JFS-signed webhook to /api/farcaster/webhook
// with a (token, url) pair. We store those tokens keyed by FID. Whenever
// writeNotification fires, we look up the recipient's FID, check the master
// toggle + per-type opt-in, and POST to the host's notification URL so the
// user receives a native FC push that opens the Mini App at the relevant
// page when tapped.
//
// Identity model:
//   - In-app bell is keyed by Ethereum address (existing behavior).
//   - FC push is keyed by FID. Address→FID via getFarcasterProfileByAddress.
//   - One FID can have multiple tokens (mobile FC + web FC = two clients
//     of the same user). We send to every token the FID has registered.
//
// Opt-in policy (persisted per-FID, see keyPushSeeded for the one-shot
// gate that prevents these defaults from clobbering user choices on churn):
//   - Master toggle: 'off' by default, auto-set to 'on' on first-ever
//     registration so the prompt's promise survives without a settings detour.
//   - Per-type opt-in: seeded with {'collect'} on first-ever registration —
//     applies whether the first event is miniapp_added (with details) or
//     notifications_enabled.
//   - User can flip both via the settings tab in NotificationModal.
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
const keyPushSeeded = (fid: number) => `kismetart:fc:push-seeded:${fid}`
const keyIdempotency = (fid: number, notificationId: string) =>
  `kismetart:fc:notif-sent:${fid}:${notificationId}`
// Index of every FID that MIGHT hold a token — the enumerable surface for
// broadcasts. Maintained by registerToken (SADD) / clearTokens (SREM) and
// backfilled once by scripts/reconcile-fc-push-fids.mjs. A member is a HINT,
// not a guarantee: the per-FID token SET can lapse on its own 365d TTL while
// the index member remains, so broadcast enumeration re-checks each FID and
// lazily prunes empties. No TTL on the index itself — same posture as the
// created-mints registry (persistent, self-healing membership).
const KEY_PUSH_FIDS = 'kismetart:fc:push-fids'
// Per-run broadcast stats, keyed by the run's notificationId — the first
// observability signal this transport has (STACK_OVERVIEW G4 gap).
const keyBroadcastRecord = (notificationId: string) => `kismetart:fc:broadcast:${notificationId}`
// Single-flight lock for broadcast runs. Host-side (FID, notificationId)
// dedupe makes concurrent runs harmless, so this only prevents wasted
// duplicate POST volume, not correctness bugs.
const BROADCAST_LOCK_KEY = 'kismetart:fc:broadcast-lock'

const IDEMPOTENCY_TTL_SECS = 24 * 60 * 60
const TOKENS_TTL_SECS = 365 * 24 * 60 * 60
const PUSH_TYPES_TTL_SECS = 365 * 24 * 60 * 60
const PUSH_MASTER_TTL_SECS = 365 * 24 * 60 * 60
const PUSH_SEEDED_TTL_SECS = 5 * 365 * 24 * 60 * 60
const BROADCAST_RECORD_TTL_SECS = 30 * 24 * 60 * 60

// Per the canonical sendNotificationRequestSchema (@farcaster/miniapp-core,
// schemas/notifications): tokens: z.string().array().max(100). One FID
// realistically has 1-3 tokens, but chunking defends against schema
// rejections on any future host that strictly validates.
const MAX_TOKENS_PER_REQUEST = 100

// Host POST timeout. Spec doesn't define one, but a hung notification
// endpoint would otherwise leak connections from the writeNotification
// fire-and-forget. 10s comfortably covers a slow host while bounding
// resource use on a stuck one.
const SEND_TIMEOUT_MS = 10_000

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
 * One-shot seeding (gated on kismetart:fc:push-seeded:<fid>):
 *   - Per-type opt-in set: seeded with DEFAULT_ENABLED_PUSH_TYPES ({collect})
 *     so the prompt's "collect alerts" promise is honored.
 *   - Master toggle: set to 'on' so push starts working immediately.
 *
 * The seeded flag means: a user who explicitly turned EVERY push type off,
 * then disabled OS notifications (which clears tokens), then re-enabled,
 * keeps their "all off" state. Without the flag, scard(push-types)==0 would
 * look identical to "never seeded" and we'd re-add {collect} unbidden. The
 * flag stamps once on the user's first-ever grant and is preserved through
 * any number of disable/enable cycles.
 */
export async function registerToken(fid: number, details: NotificationToken): Promise<void> {
  // SSRF guard: never persist a notification URL the server would later POST
  // to unless it's https + a non-internal host. Silently drop otherwise — a
  // bad URL means no push for that registration, which is the safe failure.
  if (!isSafePublicHttpsUrl(details.url)) return
  const member = JSON.stringify({ url: details.url, token: details.token })
  await redis
    .multi()
    .sadd(keyTokens(fid), member)
    .expire(keyTokens(fid), TOKENS_TTL_SECS)
    // Keep the broadcast index in the same atomic write as the token so the
    // two can't drift on a partial failure.
    .sadd(KEY_PUSH_FIDS, String(fid))
    .exec()

  // Has this FID ever been seeded? If yes, skip seed regardless of the
  // current per-type / master state — those are the user's explicit choices.
  let alreadySeeded = false
  try {
    alreadySeeded = (await redis.get<string>(keyPushSeeded(fid))) === '1'
  } catch {
    // Read failure: conservatively assume seeded so we don't double-seed
    // an existing user during a Redis blip.
    alreadySeeded = true
  }
  if (alreadySeeded) return

  // Seed per-type defaults.
  try {
    const defaults = [...DEFAULT_ENABLED_PUSH_TYPES]
    if (defaults.length > 0) {
      const [first, ...rest] = defaults
      await redis
        .multi()
        .sadd(keyPushTypes(fid), first, ...rest)
        .expire(keyPushTypes(fid), PUSH_TYPES_TTL_SECS)
        .exec()
    }
  } catch {
    // Best-effort — if seed fails the user just has zero push types until
    // they toggle one on, which is a safe degradation.
  }

  // Auto-enable master on the first registration so the prompt's promise
  // works without the user detouring to settings. Subsequent grants
  // (disable→re-enable) won't reach this block because the seeded flag
  // short-circuits above; if the user explicitly turned master off, we
  // never overwrite that.
  try {
    await redis.set(keyPushMaster(fid), 'on', { ex: PUSH_MASTER_TTL_SECS })
  } catch {
    // Non-critical — falls through to default-off, which the user can
    // flip on themselves in settings.
  }

  // Stamp the seeded flag LAST so a partial-failure seed doesn't claim
  // success. Long TTL (5y) because we never want to re-seed an existing
  // user; we'd rather lose this flag than over-seed.
  try {
    await redis.set(keyPushSeeded(fid), '1', { ex: PUSH_SEEDED_TTL_SECS })
  } catch {
    // If the flag set fails, next registerToken will re-seed (idempotent
    // operations above mean re-seed is safe — just sets the same values).
  }
}

/** Drop a single token. Internal: used by dispatch to GC tokens the host reports as invalid. */
async function unregisterToken(fid: number, details: NotificationToken): Promise<void> {
  const member = JSON.stringify({ url: details.url, token: details.token })
  await redis.srem(keyTokens(fid), member)
}

/** Drop ALL tokens for an FID (miniapp_removed or notifications_disabled). */
export async function clearTokens(fid: number): Promise<void> {
  // Deleting the tokens without the index SREM would leave a stale (but
  // harmless — broadcast re-checks and prunes) member; pairing them in one
  // MULTI keeps the index honest on the common path.
  await redis.multi().del(keyTokens(fid)).srem(KEY_PUSH_FIDS, String(fid)).exec()
}

/**
 * Purge ALL Farcaster push state for an FID — tokens AND the push-pref keys
 * (types / master / seeded). Used by admin profile-erase: clearTokens alone
 * leaves the prefs behind, so the erased identity's push settings would
 * resurface on a rebuilt profile, and until the tokens' TTL lapses it would
 * keep receiving native FC push for notifications fired by its retained
 * on-chain content. This is the FC-transport half of the "notification inbox +
 * prefs" that deleteNotificationData clears on the address side.
 */
export async function clearFarcasterPushState(fid: number): Promise<void> {
  await Promise.all([
    redis.del(keyTokens(fid)),
    redis.del(keyPushTypes(fid)),
    redis.del(keyPushMaster(fid)),
    redis.del(keyPushSeeded(fid)),
    redis.srem(KEY_PUSH_FIDS, String(fid)),
  ])
}

async function getTokens(fid: number): Promise<NotificationToken[]> {
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

// Notification `price` is stored in base units (wei / USDC-6) — the same
// convention NotificationRow renders via formatPrice. Delegate so push copy
// matches the in-app row instead of interpolating the raw integer.
function formatPushPrice(price: string, currency?: 'eth' | 'usdc'): string {
  return formatPrice(price, currency ?? 'eth')
}

// Composition mirrors components/NotificationRow.tsx so the push and the
// in-app row read identically — including the actor-absent variants
// ("your artwork was created", "your listing was filled", "an admin added
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
    n.tokenAddress && n.tokenId ? `${SITE_URL}/artwork/${n.tokenAddress}/${n.tokenId}` : SITE_URL

  switch (n.type) {
    case 'collect': {
      const priceLabel = n.price && n.price !== '0'
        ? ` for ${formatPushPrice(n.price, n.currency)}`
        : ''
      const subject = tokenName ? `"${tokenName}"` : 'your artwork'
      const who = actorName ?? 'someone'
      // Surface the buyer's optional comment so the push carries the
      // same context the in-app row does. Platform-default comments are
      // filtered out here too — matches NotificationRow's render-time
      // filter so historical rows that pre-date the write-time strip in
      // /api/collect don't push "@bob collected — collected on kismet".
      // The full-body truncate at the end handles the case where
      // comment + name + price overflow.
      const commentSuffix =
        n.comment?.trim() && !isPlatformCollectComment(n.comment)
          ? ` — "${n.comment.trim()}"`
          : ''
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
          title: truncate('Artwork created', TITLE_MAX),
          body: truncate(
            tokenName ? `Your artwork "${tokenName}" is live` : 'Your artwork was created',
            BODY_MAX,
          ),
          targetUrl: momentUrl,
        }
      }
      return {
        title: truncate(`${actorName} minted`, TITLE_MAX),
        body: truncate(
          tokenName ? `${actorName} minted "${tokenName}"` : `${actorName} minted a new artwork`,
          BODY_MAX,
        ),
        targetUrl: momentUrl,
      }
    }
    case 'gift': {
      // Collect-and-gift recipient. Always has an actor (the payer, proved
      // server-side before the notification is written), but fall back
      // gracefully rather than pushing an awkward "undefined gifted you".
      const subject = tokenName ? `"${tokenName}"` : 'an artwork'
      return {
        title: truncate('Gift received', TITLE_MAX),
        body: truncate(
          actorName ? `${actorName} gifted you ${subject}` : `You were gifted ${subject}`,
          BODY_MAX,
        ),
        targetUrl: momentUrl,
      }
    }
    case 'airdrop': {
      const subject = tokenName ? `"${tokenName}"` : 'an artwork'
      // Airdropper's own confirmation (no actor) vs airdropee (actor set).
      // Matches NotificationRow's two branches exactly.
      if (!actorName) {
        const to = n.amount && n.amount > 1 ? ` to ${n.amount} recipients` : ''
        return {
          title: truncate('Airdrop sent', TITLE_MAX),
          body: truncate(`You airdropped ${subject}${to}`, BODY_MAX),
          targetUrl: momentUrl,
        }
      }
      return {
        title: truncate('Airdrop received', TITLE_MAX),
        body: truncate(`${actorName} airdropped you ${subject}`, BODY_MAX),
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
      // amountLabel already carries the currency ("0.1 ETH" / "$5").
      const subject = tokenName ? `"${tokenName}"` : 'an artwork'
      const amountLabel = n.price ? formatPushPrice(n.price, n.currency) : 'a payout'
      return {
        title: truncate('Payout received', TITLE_MAX),
        body: truncate(`You received ${amountLabel} from ${subject}`, BODY_MAX),
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
      const subject = tokenName ? `"${tokenName}"` : 'an artwork'
      const who = actorName ?? 'someone'
      const priceLabel = n.price ? ` for ${formatPushPrice(n.price, n.currency)}` : ''
      return {
        title: truncate('New listing', TITLE_MAX),
        body: truncate(`${who} listed ${subject}${priceLabel}`, BODY_MAX),
        targetUrl: momentUrl,
      }
    }
    case 'listing_expired': {
      const subject = tokenName ? `"${tokenName}"` : 'an artwork'
      const priceLabel = n.price ? ` (${formatPushPrice(n.price, n.currency)})` : ''
      return {
        title: truncate('Listing expired', TITLE_MAX),
        body: truncate(`Your listing on ${subject} expired${priceLabel}`, BODY_MAX),
        targetUrl: momentUrl,
      }
    }
    case 'agent_collect': {
      // Self-notification: the user's own agent collected on their behalf.
      // Link to their profile (matches NotificationRow's href). amount is
      // the count; price is the run's total spend in the budget currency.
      const count = n.amount && n.amount > 1 ? `${n.amount} artworks` : 'an artwork'
      const priceLabel = n.price && n.price !== '0' ? ` for ${formatPushPrice(n.price, n.currency)}` : ''
      return {
        title: truncate('Agent collected', TITLE_MAX),
        body: truncate(`Your agent collected ${count}${priceLabel}`, BODY_MAX),
        targetUrl: `${SITE_URL}/profile/${n.recipient}`,
      }
    }
    case 'raffle_win': {
      const subject = tokenName ? `"${tokenName}"` : 'the raffle'
      return {
        title: truncate('You won the raffle', TITLE_MAX),
        body: truncate(
          `You won ${subject}! You will be contacted to receive the physical piece.`,
          BODY_MAX,
        ),
        targetUrl: momentUrl,
      }
    }
    case 'raffle_ended': {
      // `actor` is the WINNER (drawAndEnd's fan-out), so actorName announces
      // who won — mirroring NotificationRow's raffle_ended copy.
      const subject = tokenName ? `"${tokenName}"` : 'an artwork'
      const who = actorName ?? 'someone'
      return {
        title: truncate('Raffle ended', TITLE_MAX),
        body: truncate(`${who} has won the physical edition of ${subject}!`, BODY_MAX),
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
  // Defense in depth: never POST to an internal/non-https host, covering any
  // URL persisted before registerToken enforced this guard.
  if (!isSafePublicHttpsUrl(url)) return null
  // AbortController-based timeout so a hung host endpoint can't pin a
  // connection forever. Push is fire-and-forget at the writeNotification
  // call site, so the loss is just this one push.
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notificationId, title, body, targetUrl, tokens }),
      signal: controller.signal,
    })
    if (!res.ok) return null
    return (await res.json()) as HostResponse
  } catch {
    // AbortError, network error, JSON parse error — collapse to null so
    // the caller treats this as "delivery uncertain" without GC-ing tokens.
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/** Chunk an array into pieces of at most `size`. */
function chunk<T>(arr: T[], size: number): T[][] {
  if (arr.length <= size) return [arr]
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
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
    // expectation that "mute X" silences X everywhere. Exempt types
    // (ACTOR_MUTE_EXEMPT_TYPES) bypass actor-mute here for the same reason
    // loadAndAnnotate does: money-bearing events — and the raffle outcome,
    // whose actor is the announced winner — must reach the user regardless.
    // Address-keyed (matches muteActor/unmuteActor), not FID-keyed —
    // a user might mute another address that has no FC identity.
    if (
      n.actor &&
      !ACTOR_MUTE_EXEMPT_TYPES.has(n.type) &&
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
      [...byUrl.entries()].flatMap(([url, urlTokens]) =>
        // Schema caps each request at 100 tokens; chunk for safety even
        // though a single FID realistically has <5. A larger-than-max
        // request would 400 host-side and lose the whole batch.
        chunk(urlTokens, MAX_TOKENS_PER_REQUEST).map(async (batch) => {
          const result = await sendOne(
            url,
            batch,
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
      ),
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

// ---------- Broadcast (admin announcement to every opted-in user) ----------
//
// Sends ONE notification to every FID that (a) holds at least one live
// notification token — i.e. added Kismet in a Farcaster host with
// notifications enabled — and (b) has the Kismet master push toggle on.
//
// Design decisions, in spec terms (farcasterxyz/miniapps notifications spec):
//   - Recipients are FIDs, not addresses. Many token-holding FIDs have no
//     Kismet session/address, so a broadcast deliberately does NOT write
//     in-app bell entries — it is a pure FC-push transport.
//   - Per-type opt-ins are NOT consulted: those gate the 12 event-driven
//     types; a broadcast is an operator announcement, not an event class.
//     The master toggle (the user's explicit "no Kismet push") IS honored,
//     and the host-level control (user disables notifications → tokens
//     invalidated) always applies before us.
//   - No local (fid, notificationId) SETNX: hosts MUST dedupe on
//     (FID, notificationId) for 24h — that server-side key is the spec's
//     retry mechanism. Re-running the same notificationId re-attempts
//     tokens that were rate-limited or unreachable, while already-notified
//     users are deduped host-side. A local SETNX would break exactly that.
//   - One POST per (host url, ≤100 tokens) batch, same notificationId in
//     every batch (explicitly sanctioned by the spec's batching guidance).
//   - `invalidTokens` in a response are GC'd immediately, like dispatch.
//     `rateLimitedTokens` stay put — a later re-run redelivers.

/** Spec caps (sendNotificationRequestSchema, @farcaster/miniapp-core). */
export const BROADCAST_LIMITS = {
  notificationId: 128,
  title: 32,
  body: 128,
  targetUrl: 1024,
  tokensPerRequest: MAX_TOKENS_PER_REQUEST,
} as const

// Enumeration hard cap — far above the realistic index size; if it ever
// trips, the run reports `truncated: true` and logs, never silently drops
// (repo rule: no silent caps).
const BROADCAST_MAX_FIDS = 100_000
// In-flight POST bound. Each request can hold a connection for up to
// SEND_TIMEOUT_MS; 4-wide keeps a full 100-batch run well under the route's
// 300s window while staying gentle on the host endpoint.
const BROADCAST_SEND_CONCURRENCY = 4
const BROADCAST_LOCK_TTL_SECS = 10 * 60

export interface BroadcastInput {
  notificationId: string
  title: string
  body: string
  /** Defaults to SITE_URL. Host MUST equal SITE_URL's host or the Farcaster
   *  client permanently invalidates the affected tokens (target_url_mismatch). */
  targetUrl?: string
}

export type BroadcastValidation =
  | { ok: true; notificationId: string; title: string; body: string; targetUrl: string }
  | { ok: false; error: string }

/**
 * Validate + normalize a broadcast request against the spec caps. Pure —
 * exercised by scripts/verify-fc-broadcast.ts.
 *
 * Overlong title/body are REJECTED, not truncated: compose() truncation is
 * the right behavior for machine-composed event copy, but an announcement is
 * hand-written — the admin should shorten it intentionally, not discover a
 * mid-word ellipsis in production.
 */
export function validateBroadcastInput(input: BroadcastInput): BroadcastValidation {
  const notificationId = input.notificationId?.trim() ?? ''
  if (!notificationId) return { ok: false, error: 'notificationId is required' }
  if (/\s/.test(notificationId)) {
    return { ok: false, error: 'notificationId must not contain whitespace' }
  }
  if (notificationId.length > BROADCAST_LIMITS.notificationId) {
    return { ok: false, error: `notificationId exceeds ${BROADCAST_LIMITS.notificationId} chars` }
  }

  const title = input.title?.trim() ?? ''
  if (!title) return { ok: false, error: 'title is required' }
  if (title.length > BROADCAST_LIMITS.title) {
    return { ok: false, error: `title exceeds ${BROADCAST_LIMITS.title} chars (spec cap)` }
  }

  const body = input.body?.trim() ?? ''
  if (!body) return { ok: false, error: 'body is required' }
  if (body.length > BROADCAST_LIMITS.body) {
    return { ok: false, error: `body exceeds ${BROADCAST_LIMITS.body} chars (spec cap)` }
  }

  const targetUrl = input.targetUrl?.trim() || SITE_URL
  if (targetUrl.length > BROADCAST_LIMITS.targetUrl) {
    return { ok: false, error: `targetUrl exceeds ${BROADCAST_LIMITS.targetUrl} chars (spec cap)` }
  }
  let parsed: URL
  try {
    parsed = new URL(targetUrl)
  } catch {
    return { ok: false, error: 'targetUrl is not a valid URL' }
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'targetUrl must be https' }
  }
  // Exact-host equality, subdomains included. A www./subdomain drift doesn't
  // merely fail delivery — the host answers target_url_mismatch and
  // PERMANENTLY invalidates every token in the request. This guard is the
  // reason the field can't be free-form.
  const siteHost = new URL(SITE_URL).hostname
  if (parsed.hostname !== siteHost) {
    return { ok: false, error: `targetUrl host must be exactly ${siteHost}` }
  }

  return { ok: true, notificationId, title, body, targetUrl }
}

export interface BroadcastTarget {
  fid: number
  url: string
  token: string
}

/**
 * Group flat (fid, url, token) triples into per-host batches of at most 100
 * tokens (spec cap on `tokens`). Pure — exercised by the verify script.
 * Batches keep the full triple so a response's `invalidTokens` (returned as
 * bare token strings) can be mapped back to the owning FID for GC.
 */
export function groupTargetsForSend(
  targets: BroadcastTarget[],
): { url: string; batches: BroadcastTarget[][] }[] {
  const byUrl = new Map<string, BroadcastTarget[]>()
  for (const t of targets) {
    const list = byUrl.get(t.url) ?? []
    list.push(t)
    byUrl.set(t.url, list)
  }
  return [...byUrl.entries()].map(([url, list]) => ({
    url,
    batches: chunk(list, MAX_TOKENS_PER_REQUEST),
  }))
}

interface CollectedTargets {
  targets: BroadcastTarget[]
  /** FIDs contributing ≥1 token to `targets`. */
  eligibleFids: number
  /** FIDs holding tokens but with the Kismet master toggle off — skipped. */
  skippedMasterOff: number
  /** Stale index members (empty/expired token SETs) pruned this pass. */
  prunedNoTokens: number
  scannedFids: number
  truncated: boolean
}

/**
 * Walk the push-fids index and resolve every sendable (fid, url, token).
 * SSCAN cursor loop (same shape as scanCreatedMints) so the index never has
 * to fit in one reply; per-page reads fan out through Promise.all, which
 * @upstash/redis auto-pipelines into a handful of REST round-trips.
 */
async function collectBroadcastTargets(): Promise<CollectedTargets> {
  const out: CollectedTargets = {
    targets: [],
    eligibleFids: 0,
    skippedMasterOff: 0,
    prunedNoTokens: 0,
    scannedFids: 0,
    truncated: false,
  }

  // SCAN-family cursors guarantee at-least-once, not exactly-once — a member
  // can repeat across pages when the set is written mid-scan (live webhook
  // registrations). Dedupe so stats stay exact and no token is POSTed twice
  // in one run.
  const seen = new Set<number>()
  let cursor: string | number = 0
  do {
    const [next, page] = (await redis.sscan(KEY_PUSH_FIDS, cursor, {
      count: 1000,
    })) as [string | number, (string | number)[]]
    cursor = next

    // Upstash may hand members back as numbers (JSON round-trip); normalize
    // and prune anything that doesn't parse as a positive integer FID.
    const fids: number[] = []
    const malformed: string[] = []
    for (const raw of page) {
      const fid = Number(raw)
      if (Number.isInteger(fid) && fid > 0) {
        if (!seen.has(fid)) {
          seen.add(fid)
          fids.push(fid)
        }
      } else {
        malformed.push(String(raw))
      }
    }
    if (malformed.length > 0) {
      out.prunedNoTokens += malformed.length
      await redis.srem(KEY_PUSH_FIDS, ...malformed).catch(() => {})
    }

    out.scannedFids += fids.length
    if (fids.length > 0) {
      const masters = await Promise.all(fids.map((fid) => getPushMaster(fid)))
      const masterOnFids = fids.filter((_, i) => masters[i] === 'on')
      out.skippedMasterOff += fids.length - masterOnFids.length

      const tokenLists = await Promise.all(masterOnFids.map((fid) => getTokens(fid)))
      const stale: string[] = []
      masterOnFids.forEach((fid, i) => {
        const tokens = tokenLists[i]
        if (tokens.length === 0) {
          // Token SET expired (365d TTL) or was emptied by GC — the index
          // member is stale. Prune so future runs shrink toward truth.
          stale.push(String(fid))
          return
        }
        out.eligibleFids++
        for (const t of tokens) out.targets.push({ fid, url: t.url, token: t.token })
      })
      if (stale.length > 0) {
        out.prunedNoTokens += stale.length
        await redis.srem(KEY_PUSH_FIDS, ...stale).catch(() => {})
      }
    }

    if (out.scannedFids >= BROADCAST_MAX_FIDS) {
      out.truncated = true
      console.warn(
        `[fc-broadcast] index scan hit the ${BROADCAST_MAX_FIDS}-fid cap; remaining fids skipped this run`,
      )
      break
    }
  } while (String(cursor) !== '0')

  return out
}

export interface BroadcastReach {
  eligibleFids: number
  tokens: number
  /** Token count per host notification endpoint (e.g. the Farcaster client
   *  vs the Base app) — the broadcast POSTs to every one of these. */
  hosts: Record<string, number>
  skippedMasterOff: number
  prunedNoTokens: number
  truncated: boolean
}

/** Dry-run: enumerate who a broadcast would reach without sending anything. */
export async function estimateBroadcastReach(): Promise<BroadcastReach> {
  const collected = await collectBroadcastTargets()
  const hosts: Record<string, number> = {}
  for (const t of collected.targets) hosts[t.url] = (hosts[t.url] ?? 0) + 1
  return {
    eligibleFids: collected.eligibleFids,
    tokens: collected.targets.length,
    hosts,
    skippedMasterOff: collected.skippedMasterOff,
    prunedNoTokens: collected.prunedNoTokens,
    truncated: collected.truncated,
  }
}

export interface BroadcastRunResult {
  ok: true
  notificationId: string
  eligibleFids: number
  skippedMasterOff: number
  prunedNoTokens: number
  /** POSTs attempted / POSTs that got no usable 200 (network, timeout, 4xx/5xx). */
  requests: number
  failedRequests: number
  successfulTokens: number
  /** Tokens the hosts declared dead — GC'd from storage during this run. */
  invalidTokens: number
  /** Tokens deferred by host rate limits — kept; re-run ≥30s later to retry. */
  rateLimitedTokens: number
  truncated: boolean
  durationMs: number
}

export type BroadcastOutcome =
  | BroadcastRunResult
  | { ok: false; error: 'locked' }
  | { ok: false; error: 'invalid-input'; detail: string }

/** Fixed-width worker pool — bounds in-flight POSTs without a dependency. */
async function runBounded<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = nextIndex++
      if (i >= items.length) return
      await worker(items[i])
    }
  })
  await Promise.all(lanes)
}

/**
 * Send an announcement to every eligible user. Admin-triggered (see
 * /api/admin/broadcast); errors propagate to the caller — unlike
 * dispatchFarcasterPush this is not fire-and-forget infrastructure, the
 * operator is watching and a failed run must be visible.
 *
 * Safe to re-run with the SAME notificationId: hosts dedupe delivered
 * (FID, notificationId) pairs for 24h, so a re-run only reaches tokens that
 * were rate-limited, unreachable, or newly registered.
 */
export async function broadcastFarcasterPush(input: BroadcastInput): Promise<BroadcastOutcome> {
  const validated = validateBroadcastInput(input)
  if (!validated.ok) return { ok: false, error: 'invalid-input', detail: validated.error }

  const lock = await acquireLock(BROADCAST_LOCK_KEY, BROADCAST_LOCK_TTL_SECS)
  if (!lock.acquired) return { ok: false, error: 'locked' }

  const started = Date.now()
  try {
    const collected = await collectBroadcastTargets()
    const grouped = groupTargetsForSend(collected.targets)

    const result: BroadcastRunResult = {
      ok: true,
      notificationId: validated.notificationId,
      eligibleFids: collected.eligibleFids,
      skippedMasterOff: collected.skippedMasterOff,
      prunedNoTokens: collected.prunedNoTokens,
      requests: 0,
      failedRequests: 0,
      successfulTokens: 0,
      invalidTokens: 0,
      rateLimitedTokens: 0,
      truncated: collected.truncated,
      durationMs: 0,
    }

    const jobs = grouped.flatMap(({ url, batches }) =>
      batches.map((batch) => ({ url, batch })),
    )

    await runBounded(jobs, BROADCAST_SEND_CONCURRENCY, async ({ url, batch }) => {
      result.requests++
      const res = await sendOne(
        url,
        batch.map((t) => t.token),
        validated.notificationId,
        validated.title,
        validated.body,
        validated.targetUrl,
      )
      if (!res?.result) {
        // Delivery uncertain (timeout / network / non-200). Tokens are NOT
        // GC'd — a re-run retries them and host dedupe absorbs any overlap.
        result.failedRequests++
        return
      }
      result.successfulTokens += res.result.successfulTokens?.length ?? 0
      result.rateLimitedTokens += res.result.rateLimitedTokens?.length ?? 0
      const invalid = res.result.invalidTokens ?? []
      if (invalid.length === 0) return
      result.invalidTokens += invalid.length
      // Map bare token strings back to owners within this batch for GC. The
      // GC is best-effort: a Redis blip here must not abort the remaining
      // batches of a run whose sends are already in flight — an un-GC'd dead
      // token just resurfaces in the next run's invalidTokens.
      const byToken = new Map(batch.map((t) => [t.token, t.fid]))
      await Promise.all(
        invalid.map((tok) => {
          const fid = byToken.get(tok)
          return fid
            ? unregisterToken(fid, { url, token: tok }).catch(() => {})
            : Promise.resolve()
        }),
      )
    })

    result.durationMs = Date.now() - started

    // Best-effort observability: per-run record (30d) + one summary log line
    // (OPS_RUNBOOK watches the [fc-broadcast] prefix). Record write failure
    // must not fail a run whose sends already happened.
    try {
      await redis.set(
        keyBroadcastRecord(validated.notificationId),
        JSON.stringify({ ...result, title: validated.title, ts: Date.now() }),
        { ex: BROADCAST_RECORD_TTL_SECS },
      )
    } catch {
      // Stats are advisory; the log line below still records the run.
    }
    console.log(
      '[fc-broadcast] run complete',
      JSON.stringify({
        notificationId: validated.notificationId,
        eligibleFids: result.eligibleFids,
        requests: result.requests,
        failedRequests: result.failedRequests,
        successful: result.successfulTokens,
        invalid: result.invalidTokens,
        rateLimited: result.rateLimitedTokens,
        ms: result.durationMs,
      }),
    )

    return result
  } finally {
    await lock.release()
  }
}

export interface BroadcastTestResult {
  ok: true
  fid: number
  tokens: number
  successfulTokens: number
  invalidTokens: number
  rateLimitedTokens: number
  failedRequests: number
}

export type BroadcastTestOutcome =
  | BroadcastTestResult
  | { ok: false; error: 'invalid-input'; detail: string }
  | { ok: false; error: 'no-tokens' }
  | { ok: false; error: 'master-off' }

/**
 * Send the announcement to a SINGLE FID — the smoke test before a real
 * broadcast. Identical validation, identical gates (master toggle included:
 * a test must never become a consent bypass, admin-only or not), identical
 * send path; only the enumeration is skipped.
 *
 * The caller should use a scratch notificationId (the admin UI appends
 * `-test`): hosts dedupe (FID, notificationId) for 24h, so testing with the
 * REAL id would suppress the tester's copy of the actual broadcast.
 */
export async function sendBroadcastTestTo(
  fid: number,
  input: BroadcastInput,
): Promise<BroadcastTestOutcome> {
  const validated = validateBroadcastInput(input)
  if (!validated.ok) return { ok: false, error: 'invalid-input', detail: validated.error }

  if (!(await isPushMasterOn(fid))) return { ok: false, error: 'master-off' }
  const tokens = await getTokens(fid)
  if (tokens.length === 0) return { ok: false, error: 'no-tokens' }

  const result: BroadcastTestResult = {
    ok: true,
    fid,
    tokens: tokens.length,
    successfulTokens: 0,
    invalidTokens: 0,
    rateLimitedTokens: 0,
    failedRequests: 0,
  }

  // One FID can hold tokens on multiple hosts (Farcaster app + Base app);
  // reuse the broadcast grouping so the test exercises the same code path.
  for (const { url, batches } of groupTargetsForSend(
    tokens.map((t) => ({ fid, url: t.url, token: t.token })),
  )) {
    for (const batch of batches) {
      const res = await sendOne(
        url,
        batch.map((t) => t.token),
        validated.notificationId,
        validated.title,
        validated.body,
        validated.targetUrl,
      )
      if (!res?.result) {
        result.failedRequests++
        continue
      }
      result.successfulTokens += res.result.successfulTokens?.length ?? 0
      result.rateLimitedTokens += res.result.rateLimitedTokens?.length ?? 0
      const invalid = res.result.invalidTokens ?? []
      result.invalidTokens += invalid.length
      await Promise.all(
        invalid.map((tok) => unregisterToken(fid, { url, token: tok }).catch(() => {})),
      )
    }
  }

  return result
}

/** Fetch a stored per-run stats record (30d retention). */
export async function getBroadcastRecord(
  notificationId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await redis.get(keyBroadcastRecord(notificationId))
    if (raw == null) return null
    if (typeof raw === 'object') return raw as Record<string, unknown>
    return JSON.parse(String(raw)) as Record<string, unknown>
  } catch {
    return null
  }
}
