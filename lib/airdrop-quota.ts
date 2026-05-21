import { redis } from './redis'
import { ADMIN_ADDRESS } from './config'

/**
 * Per-artist airdrop quota ledger. Two buckets per artist:
 *
 *   - DAY  (cadence) — resets at UTC midnight, default 1
 *   - WEEK (cap)     — resets Monday 00:00 UTC, default 5
 *
 * Each recipient in a multi-recipient airdrop counts as one mint against
 * both buckets. Admin is exempt and never touches the ledger.
 *
 * Soft enforcement: a determined artist can skip /api/airdrop/notify
 * entirely (the on-chain mint is direct), so this is a fairness ceiling
 * for the curated cohort, not an anti-abuse gate. To make it a hard gate
 * we'd need to either route airdrop signing through a server or gate the
 * on-chain MINTER permission grant itself — both deferred.
 */

const KEY_LIMIT_DAY = 'kismetart:airdrop-quota:limit:day'
const KEY_LIMIT_WEEK = 'kismetart:airdrop-quota:limit:week'

const DEFAULT_LIMIT_DAY = 1
const DEFAULT_LIMIT_WEEK = 5

// Margin past each window so a late-window INCR still sees its own write
// even if the request straddles the boundary. Day bucket reaps after 25h,
// week after 8 days — older buckets are reclaimed by Redis on their own.
const TTL_DAY_SECONDS = 25 * 60 * 60
const TTL_WEEK_SECONDS = 8 * 24 * 60 * 60

export interface AirdropLimits {
  /** Max airdrop mints per UTC calendar day. */
  day: number
  /** Max airdrop mints per ISO week (Monday-start, UTC). */
  week: number
}

export interface AirdropQuotaStatus {
  limits: AirdropLimits
  used: { day: number; week: number }
  remaining: { day: number; week: number }
}

export type ConsumeResult =
  | { ok: true; used: { day: number; week: number } }
  | {
      ok: false
      reason: 'day_cap' | 'week_cap'
      limits: AirdropLimits
      used: { day: number; week: number }
    }

function dayBucket(d: Date = new Date()): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

// ISO 8601 week: Monday-start, week 1 is the week containing Jan 4 — matches
// `date -u +%G-W%V`. We compute via the Thursday trick: the ISO week-numbering
// year is the one containing that week's Thursday, which is also the year
// boundary that decides whether late-December weeks belong to next year.
function weekBucket(d: Date = new Date()): string {
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = tmp.getUTCDay() || 7
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${tmp.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`
}

const dayKey = (artist: string) =>
  `kismetart:airdrop-quota:${artist.toLowerCase()}:d:${dayBucket()}`
const weekKey = (artist: string) =>
  `kismetart:airdrop-quota:${artist.toLowerCase()}:w:${weekBucket()}`

function isAdmin(addr: string): boolean {
  return !!ADMIN_ADDRESS && addr.toLowerCase() === ADMIN_ADDRESS
}

function clampNonNegativeInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.floor(value))
}

export async function getLimits(): Promise<AirdropLimits> {
  try {
    const [d, w] = await Promise.all([
      redis.get<string>(KEY_LIMIT_DAY),
      redis.get<string>(KEY_LIMIT_WEEK),
    ])
    return {
      day: d != null ? clampNonNegativeInt(parseInt(d, 10), DEFAULT_LIMIT_DAY) : DEFAULT_LIMIT_DAY,
      week: w != null ? clampNonNegativeInt(parseInt(w, 10), DEFAULT_LIMIT_WEEK) : DEFAULT_LIMIT_WEEK,
    }
  } catch {
    return { day: DEFAULT_LIMIT_DAY, week: DEFAULT_LIMIT_WEEK }
  }
}

export async function setLimits(input: AirdropLimits): Promise<AirdropLimits> {
  const day = clampNonNegativeInt(input.day, DEFAULT_LIMIT_DAY)
  const week = clampNonNegativeInt(input.week, DEFAULT_LIMIT_WEEK)
  if (day > week) {
    // Day > week would let the day cadence outpace the week cap, which
    // would either hard-stall after one day (week exhausted) or make the
    // week cap meaningless. Reject so the admin re-checks the intent.
    throw new Error('Day limit cannot exceed week limit')
  }
  await Promise.all([
    redis.set(KEY_LIMIT_DAY, String(day)),
    redis.set(KEY_LIMIT_WEEK, String(week)),
  ])
  return { day, week }
}

export async function getQuotaStatus(artist: string): Promise<AirdropQuotaStatus> {
  const limits = await getLimits()
  if (isAdmin(artist)) {
    // Admin reports unbounded remaining without ever touching the ledger
    // so the AirdropForm's button label / disable logic ignores quota for
    // them. Treat MAX_SAFE_INTEGER as the "unlimited" sentinel; the form
    // hides the remaining caption when it sees that value.
    return {
      limits,
      used: { day: 0, week: 0 },
      remaining: { day: Number.MAX_SAFE_INTEGER, week: Number.MAX_SAFE_INTEGER },
    }
  }
  try {
    const [d, w] = await Promise.all([
      redis.get<string>(dayKey(artist)),
      redis.get<string>(weekKey(artist)),
    ])
    const usedDay = parseInt(d ?? '0', 10) || 0
    const usedWeek = parseInt(w ?? '0', 10) || 0
    return {
      limits,
      used: { day: usedDay, week: usedWeek },
      remaining: {
        day: Math.max(0, limits.day - usedDay),
        week: Math.max(0, limits.week - usedWeek),
      },
    }
  } catch {
    return {
      limits,
      used: { day: 0, week: 0 },
      remaining: { day: limits.day, week: limits.week },
    }
  }
}

// Atomic check-and-debit for both buckets in one Lua call. Reading the
// counts and the conditional INCRBY/EXPIRE inside a single script means
// two concurrent notify requests on the same wallet can't both pass a
// `remaining=1` check and double-debit; one fully completes before the
// other starts. EXPIRE runs only on the first INCRBY of each bucket so
// the window stays fixed instead of sliding.
const CONSUME_LUA = `
local cur_d = tonumber(redis.call('GET', KEYS[1]) or '0')
local cur_w = tonumber(redis.call('GET', KEYS[2]) or '0')
local n = tonumber(ARGV[1])
local lim_d = tonumber(ARGV[2])
local lim_w = tonumber(ARGV[3])
local ttl_d = tonumber(ARGV[4])
local ttl_w = tonumber(ARGV[5])

if cur_d + n > lim_d then
  return {0, 'day_cap', cur_d, cur_w}
end
if cur_w + n > lim_w then
  return {0, 'week_cap', cur_d, cur_w}
end

local new_d = redis.call('INCRBY', KEYS[1], n)
local new_w = redis.call('INCRBY', KEYS[2], n)

if new_d == n then redis.call('EXPIRE', KEYS[1], ttl_d) end
if new_w == n then redis.call('EXPIRE', KEYS[2], ttl_w) end

return {1, 'ok', new_d, new_w}
`

export async function consumeQuota(artist: string, n: number): Promise<ConsumeResult> {
  if (n <= 0) return { ok: true, used: { day: 0, week: 0 } }
  if (isAdmin(artist)) return { ok: true, used: { day: 0, week: 0 } }

  const limits = await getLimits()
  try {
    const raw = (await redis.eval(
      CONSUME_LUA,
      [dayKey(artist), weekKey(artist)],
      [n, limits.day, limits.week, TTL_DAY_SECONDS, TTL_WEEK_SECONDS],
    )) as unknown

    if (!Array.isArray(raw) || raw.length !== 4) {
      // Malformed response — fail open so a Redis hiccup doesn't break
      // airdrops for the curated cohort. Same tradeoff lib/ratelimit makes.
      return { ok: true, used: { day: 0, week: 0 } }
    }
    const okFlag = Number(raw[0])
    const reason = String(raw[1])
    const usedDay = Number(raw[2]) || 0
    const usedWeek = Number(raw[3]) || 0

    if (okFlag === 1) {
      return { ok: true, used: { day: usedDay, week: usedWeek } }
    }
    return {
      ok: false,
      reason: reason === 'week_cap' ? 'week_cap' : 'day_cap',
      limits,
      used: { day: usedDay, week: usedWeek },
    }
  } catch {
    return { ok: true, used: { day: 0, week: 0 } }
  }
}
