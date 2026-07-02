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
  | 'collection'
  | 'update-uri'
  | 'distribute'
  | 'transcode'

interface QuotaWindow {
  /** Cap per UTC calendar day. */
  day: number
  /** Cap per ISO week (Monday-start, UTC) — defense against bursty days. */
  week: number
}

// Per-identity ceilings (admin-exempt, fail-open). Daily is the primary
// lever; weekly (~5× daily) catches sustained-not-bursty abuse without
// wall'ing a consistently-active creator. Mints are one-per-user-action (no
// bulk loop in MintForm), so counts accrue only through manual repetition.
const QUOTAS: Record<QuotaKind, QuotaWindow> = {
  // Moment creations. 50/day covers any normal creator; a larger drop
  // session is rare and resumes the next day. write = writing moments
  // (separate endpoint, same intent + ceiling).
  mint:           { day: 50,           week: 250            },
  write:          { day: 50,           week: 250            },
  // Metadata JSON only — media streams via /api/sign. Generous; never the
  // binding limit, just caps a metadata-spam abuser.
  'upload-bytes': { day: 500 * 1024 * 1024,  week: 2 * 1024 * 1024 * 1024 },
  // Media-upload signings. Sits above a maxed legit day (50 mints ×≤2 signs
  // + 25 collections ≈ 125) so the mint/collection caps bind first. Bytes
  // can't be metered here (media streams client → Turbo); the operationally-
  // capped wallet balance is the real Arweave backstop (see sign/route.ts).
  'sign-calls':   { day: 200,          week: 1000           },
  // Collection registrations. Nobody legit creates 25/day; bounds feed/KV
  // spam. The on-chain deploy is the caller's own gas — this caps our side.
  'collection':   { day: 25,           week: 100            },
  // Owner-gated inprocess-key actions that submit a sponsored on-chain tx
  // (gas paid by the platform smart wallet). Above any legitimate cadence.
  'update-uri':   { day: 50,           week: 200            },
  'distribute':   { day: 100,          week: 400            },
  // Server-side GIF→MP4 transcodes. Each pulls up to MAX_GIF_BYTES of media +
  // an ffmpeg encode through the single MAX_CONCURRENT=1 slot, so this bounds
  // per-identity compute abuse (the IP rate limit is trivially rotated).
  // Debited BEFORE the fetch/encode (see transcode-gif route), separate from
  // the post-encode upload-bytes debit that meters stored Arweave bytes.
  'transcode':    { day: 30,           week: 120            },
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

// Returns 1 when the debit fits both buckets (and applies it), 0 when it
// would exceed either cap. EXPIRE runs only on a bucket's first INCRBY so the
// window stays fixed, not sliding.
const CONSUME_LUA = `
local cur_d = tonumber(redis.call('GET', KEYS[1]) or '0')
local cur_w = tonumber(redis.call('GET', KEYS[2]) or '0')
local n = tonumber(ARGV[1])
if cur_d + n > tonumber(ARGV[2]) then return 0 end
if cur_w + n > tonumber(ARGV[3]) then return 0 end
local new_d = redis.call('INCRBY', KEYS[1], n)
local new_w = redis.call('INCRBY', KEYS[2], n)
if new_d == n then redis.call('EXPIRE', KEYS[1], ARGV[4]) end
if new_w == n then redis.call('EXPIRE', KEYS[2], ARGV[5]) end
return 1
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
    const raw = await redis.eval(
      CONSUME_LUA,
      [dayKey(kind, address), weekKey(kind, address)],
      [n, window.day, window.week, TTL_DAY_SECONDS, TTL_WEEK_SECONDS],
    )
    // Only an explicit 0 (cap hit) denies; 1 or any unexpected shape allows
    // (fail open) — same policy as the catch below and the rate limiter.
    return raw !== 0 && raw !== '0'
  } catch {
    return true
  }
}
