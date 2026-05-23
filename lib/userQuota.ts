import { redis } from './redis'
import { ADMIN_ADDRESS } from './config'

/**
 * Per-address daily/weekly quotas for platform-paid operations.
 *
 * Why this exists: rate limits in lib/ratelimit.ts are IP-scoped, which an
 * attacker rotates around trivially. The expensive endpoints — mint/write
 * (charged to INPROCESS_API_KEY), upload (Arweave bytes), sign (Arweave
 * deep-hash signing, which the client uses to upload arbitrary-size data
 * via Turbo billed to NEXT_PUBLIC_ARWEAVE_PAID_BY) — all spend platform
 * credit per authenticated identity. Bind the budget to that identity.
 *
 * Atomicity: same Lua pattern as lib/airdrop-quota.ts — check + INCRBY in
 * one script invocation so concurrent requests can't both pass a near-
 * boundary remaining check. EXPIRE runs on first INCRBY of each bucket
 * so the window stays fixed, not sliding.
 *
 * Admin bypass: admin never debits, mirroring airdrop-quota. Fails open
 * on Redis blip (same trade-off the rate limiter makes) so a transient
 * outage doesn't deny every legitimate user.
 */

export type QuotaKind =
  | 'mint'
  | 'write'
  | 'upload-bytes'
  | 'sign-calls'
  | 'update-uri'
  | 'distribute'

interface QuotaWindow {
  /** Cap per UTC calendar day. */
  day: number
  /** Cap per ISO week (Monday-start, UTC) — defense against bursty days. */
  week: number
}

// These are abuse CEILINGS, not product knobs — every limit is set far above
// any plausible legitimate cadence so a real creator (including a prolific
// drop session) never hits one, while a runaway script is bounded to a non-
// catastrophic level instead of the IP rate limit's ~28k/day theoretical max.
// Mints are one-per-user-action (no bulk loop in MintForm), so daily counts
// only accrue through manual repetition. Do not tighten without usage data.
const QUOTAS: Record<QuotaKind, QuotaWindow> = {
  // ~one mint every ~5 min for 24h straight before the cap — no human does
  // that; a script does. Bounds platform inprocess spend per identity.
  mint:           { day: 300,          week: 1000           },
  write:          { day: 300,          week: 1000           },
  // Byte-denominated (Turbo bills by bytes). NOTE: /api/upload only carries
  // JSON metadata (≤50 MB each); media streams through /api/sign. 500 MB/day
  // of metadata is thousands of mints — never a real ceiling, but caps a
  // metadata-spam abuser.
  'upload-bytes': { day: 500 * 1024 * 1024,  week: 2 * 1024 * 1024 * 1024 },
  // COUNT of media-upload signings. Bytes can't be metered here (media
  // streams client → Turbo, never reaching the server), so this count + an
  // operationally-capped wallet balance are the controls (see
  // app/api/sign/route.ts). A video mint is 2 signings (media + poster);
  // 600/day clears ~300 video mints/day.
  'sign-calls':   { day: 600,          week: 2000           },
  // Owner-gated inprocess-key actions that submit a sponsored on-chain tx
  // (gas paid by the platform smart wallet). Above any legitimate cadence;
  // bound an authorized owner from spamming gas-burning calls on their token.
  'update-uri':   { day: 50,           week: 200            },
  'distribute':   { day: 100,          week: 400            },
}

const TTL_DAY_SECONDS = 25 * 60 * 60       // 25h: covers boundary requests
const TTL_WEEK_SECONDS = 8 * 24 * 60 * 60  // 8d: same idea

function dayBucket(d: Date = new Date()): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

// ISO week via the Thursday trick (matches lib/airdrop-quota.ts).
function weekBucket(d: Date = new Date()): string {
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = tmp.getUTCDay() || 7
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${tmp.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`
}

const dayKey = (kind: QuotaKind, address: string) =>
  `kismetart:uq:${kind}:${address.toLowerCase()}:d:${dayBucket()}`
const weekKey = (kind: QuotaKind, address: string) =>
  `kismetart:uq:${kind}:${address.toLowerCase()}:w:${weekBucket()}`

function isAdmin(addr: string): boolean {
  return !!ADMIN_ADDRESS && addr.toLowerCase() === ADMIN_ADDRESS
}

const CONSUME_LUA = `
local cur_d = tonumber(redis.call('GET', KEYS[1]) or '0')
local cur_w = tonumber(redis.call('GET', KEYS[2]) or '0')
local n = tonumber(ARGV[1])
local lim_d = tonumber(ARGV[2])
local lim_w = tonumber(ARGV[3])
if cur_d + n > lim_d then return {0, 'day_cap', cur_d, cur_w} end
if cur_w + n > lim_w then return {0, 'week_cap', cur_d, cur_w} end
local new_d = redis.call('INCRBY', KEYS[1], n)
local new_w = redis.call('INCRBY', KEYS[2], n)
if new_d == n then redis.call('EXPIRE', KEYS[1], ARGV[4]) end
if new_w == n then redis.call('EXPIRE', KEYS[2], ARGV[5]) end
return {1, 'ok', new_d, new_w}
`

/**
 * Atomically debit `n` against the kind's day + week buckets. Returns true
 * when allowed (under cap), false when the debit would exceed either cap.
 * Fails OPEN (true) on a Redis hiccup — same policy as the rate limiter, and
 * the reason a transient outage can never block a legitimate mint. Admin and
 * non-positive/empty inputs bypass.
 */
export async function consumeUserQuota(
  kind: QuotaKind,
  address: string,
  n: number = 1,
): Promise<boolean> {
  if (n <= 0 || !address) return true
  if (isAdmin(address)) return true

  const window = QUOTAS[kind]
  try {
    const raw = (await redis.eval(
      CONSUME_LUA,
      [dayKey(kind, address), weekKey(kind, address)],
      [n, window.day, window.week, TTL_DAY_SECONDS, TTL_WEEK_SECONDS],
    )) as unknown
    if (!Array.isArray(raw) || raw.length === 0) return true // malformed → fail open
    return Number(raw[0]) === 1
  } catch {
    return true
  }
}
