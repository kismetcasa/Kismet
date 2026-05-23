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

export interface QuotaWindow {
  /** Cap per UTC calendar day. */
  day: number
  /** Cap per ISO week (Monday-start, UTC) — defense against bursty days. */
  week: number
}

const QUOTAS: Record<QuotaKind, QuotaWindow> = {
  mint:           { day: 50,           week: 200            },
  write:          { day: 50,           week: 200            },
  // Upload is byte-denominated because Turbo bills by bytes. 500 MB/day
  // is well above any plausible single user's legitimate output and well
  // below "an attacker is meaningfully draining the wallet" territory.
  'upload-bytes': { day: 500 * 1024 * 1024,  week: 2 * 1024 * 1024 * 1024 },
  // sign-calls bounds the COUNT of media-upload signings per identity.
  // The bytes can't be metered here (the media streams client → Turbo and
  // never reaches the server), so this count + an operationally-capped
  // wallet balance are the controls. See app/api/sign/route.ts.
  'sign-calls':   { day: 200,          week: 800            },
  // Owner-gated inprocess-key actions that submit a sponsored on-chain tx
  // (gas paid by the platform smart wallet). Generous ceilings — these are
  // far above any legitimate cadence — that bound an authorized owner from
  // spamming gas-burning no-op calls on their own token.
  'update-uri':   { day: 20,           week: 50             },
  'distribute':   { day: 50,           week: 200            },
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

export type ConsumeResult =
  | { ok: true }
  | { ok: false; reason: 'day_cap' | 'week_cap'; window: QuotaWindow; used: { day: number; week: number } }

export async function consumeUserQuota(
  kind: QuotaKind,
  address: string,
  n: number = 1,
): Promise<ConsumeResult> {
  if (n <= 0 || !address) return { ok: true }
  if (isAdmin(address)) return { ok: true }

  const window = QUOTAS[kind]
  try {
    const raw = (await redis.eval(
      CONSUME_LUA,
      [dayKey(kind, address), weekKey(kind, address)],
      [n, window.day, window.week, TTL_DAY_SECONDS, TTL_WEEK_SECONDS],
    )) as unknown

    if (!Array.isArray(raw) || raw.length !== 4) {
      // Malformed eval response — fail open so a Redis hiccup doesn't
      // hard-stop every user. Matches the rate-limiter's policy.
      return { ok: true }
    }
    const okFlag = Number(raw[0])
    const reason = String(raw[1])
    if (okFlag === 1) return { ok: true }
    return {
      ok: false,
      reason: reason === 'week_cap' ? 'week_cap' : 'day_cap',
      window,
      used: { day: Number(raw[2]) || 0, week: Number(raw[3]) || 0 },
    }
  } catch {
    return { ok: true }
  }
}

export interface QuotaStatus {
  kind: QuotaKind
  window: QuotaWindow
  used: { day: number; week: number }
  remaining: { day: number; week: number }
}

/** Read-only status snapshot for UI. Admin reports MAX_SAFE_INTEGER remaining. */
export async function getUserQuotaStatus(
  kind: QuotaKind,
  address: string,
): Promise<QuotaStatus> {
  const window = QUOTAS[kind]
  if (isAdmin(address)) {
    return {
      kind,
      window,
      used: { day: 0, week: 0 },
      remaining: { day: Number.MAX_SAFE_INTEGER, week: Number.MAX_SAFE_INTEGER },
    }
  }
  try {
    const [d, w] = await Promise.all([
      redis.get<string>(dayKey(kind, address)),
      redis.get<string>(weekKey(kind, address)),
    ])
    const usedDay = parseInt(d ?? '0', 10) || 0
    const usedWeek = parseInt(w ?? '0', 10) || 0
    return {
      kind,
      window,
      used: { day: usedDay, week: usedWeek },
      remaining: {
        day: Math.max(0, window.day - usedDay),
        week: Math.max(0, window.week - usedWeek),
      },
    }
  } catch {
    return {
      kind,
      window,
      used: { day: 0, week: 0 },
      remaining: { day: window.day, week: window.week },
    }
  }
}
