import { formatEther, formatUnits } from 'viem'
import { redis } from './redis'
import { getProfileBatch } from './profile'
import { getHiddenUsersSet } from './hidden-users'

// ─── Artist sales stats (v1: PRIMARY SALES ONLY) ─────────────────────────────
//
// Scope is deliberately narrow to keep this simple: primary mints/collects
// only — NO secondary (Seaport) sales and NO split payouts. Two metrics per
// artist (attributed to the moment's creator):
//
//   - artworks sold → total editions collected across all the artist's moments
//   - amount earned → GROSS sale price (pricePerToken × quantity), tracked
//                     per-currency. ETH and USDC are kept in SEPARATE keys
//                     because they can't be summed without a price oracle
//                     (USD normalization is deferred — see EARNINGS design).
//
// "Earned" is the price the collector paid for the artwork(s); it excludes
// Zora's separate protocol mintFee (not artist revenue) and is GROSS of any
// splits / residencies / platform referral cut. Free mints count toward
// "sold" with zero "earned".
//
// Storage: three sorted sets keyed by metric, member = creator address. Each
// set therefore doubles as a leaderboard (ZREVRANGE) and a per-artist lookup
// (ZSCORE), and ZINCRBY makes every update atomic — same pattern as
// TRENDING_KEY. Scores are float64: exact for the integer edition count up to
// 2^53, and good to ~15 significant digits for the running ETH/USDC totals,
// which is plenty for ranking + display. If accounting-grade exactness is ever
// required, move the money totals to integer base units in a hash.
export const STATS_SOLD_KEY = 'kismetart:stats:sold'
export const STATS_EARNED_ETH_KEY = 'kismetart:stats:earned:eth'
export const STATS_EARNED_USDC_KEY = 'kismetart:stats:earned:usdc'

export type EarningsMetric = 'sold' | 'eth' | 'usdc'

const KEY_BY_METRIC: Record<EarningsMetric, string> = {
  sold: STATS_SOLD_KEY,
  eth: STATS_EARNED_ETH_KEY,
  usdc: STATS_EARNED_USDC_KEY,
}

export interface ArtistStat {
  address: string
  username?: string
  avatarUrl?: string
  /** Total primary editions sold across the artist's moments. */
  sold: number
  /** Gross primary ETH earned (whole ETH, not wei). */
  earnedEth: number
  /** Gross primary USDC earned (whole USDC, not 6dp base units). */
  earnedUsdc: number
}

/**
 * Record a single verified primary sale against the artist (the moment's
 * creator). Call ONLY from a path that has already verified the mint on-chain
 * and is idempotency-gated (e.g. /api/collect) so a sale is never double
 * counted. `pricePerToken` is per-edition in base units (wei for ETH, 6dp for
 * USDC); pass it with `currency` to credit earnings — omit both for a price we
 * couldn't derive (the edition count is still recorded).
 *
 * Best-effort by contract: this never throws into the caller. Stats are a
 * derived convenience, never worth breaking a collect over.
 */
export async function recordPrimarySale(params: {
  artist: string
  amount: number
  pricePerToken?: string | null
  currency?: 'eth' | 'usdc'
}): Promise<void> {
  const { artist, amount, pricePerToken, currency } = params
  if (!artist || !/^0x[0-9a-fA-F]{40}$/.test(artist)) return
  const member = artist.toLowerCase()
  const editions = Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 1

  try {
    const ops: Promise<unknown>[] = [redis.zincrby(STATS_SOLD_KEY, editions, member)]

    if (pricePerToken && currency) {
      let total: bigint
      try {
        total = BigInt(pricePerToken) * BigInt(editions)
      } catch {
        total = 0n
      }
      if (total > 0n) {
        // Convert base units → whole-token float so the score is a
        // human-readable amount (and the two currencies stay comparable
        // within their own key). Auto-pipelining batches these into one
        // round trip with the sold increment above.
        const whole =
          currency === 'eth' ? Number(formatEther(total)) : Number(formatUnits(total, 6))
        if (Number.isFinite(whole) && whole > 0) {
          ops.push(redis.zincrby(KEY_BY_METRIC[currency], whole, member))
        }
      }
    }

    await Promise.all(ops)
  } catch {
    // Stats are non-critical — swallow so the collect recording never breaks.
  }
}

/** ZSCORE a set of members in one (auto-pipelined) round trip. Missing → omitted. */
async function scoresFor(key: string, members: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (members.length === 0) return out
  try {
    const scores = await Promise.all(members.map((m) => redis.zscore(key, m)))
    members.forEach((m, i) => {
      const s = scores[i]
      if (s !== null && s !== undefined && Number.isFinite(Number(s))) {
        out.set(m, Number(s))
      }
    })
  } catch {
    // leave empty — callers treat a missing score as 0
  }
  return out
}

/**
 * Top artists ranked by `metric`, newest leaderboard read. Every row carries
 * all three figures (sold + both currencies) regardless of the ranking metric.
 * Admin-hidden users are stripped — same public-feed gate as search/payments —
 * so we over-fetch from the zset and trim to `limit` after filtering.
 */
export async function getLeaderboard(
  metric: EarningsMetric,
  limit = 50,
): Promise<ArtistStat[]> {
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit) || 50))
  // Over-fetch headroom so the hidden-user filter can't starve the result.
  const fetchN = Math.min(300, safeLimit * 2 + 10)

  let raw: (string | number)[]
  try {
    raw = (await redis.zrange(KEY_BY_METRIC[metric], 0, fetchN - 1, {
      rev: true,
      withScores: true,
    })) as (string | number)[]
  } catch {
    return []
  }

  // withScores returns a flat [member, score, member, score, …] array.
  const ranked: string[] = []
  for (let i = 0; i < raw.length; i += 2) ranked.push(String(raw[i]).toLowerCase())
  if (ranked.length === 0) return []

  const hidden = await getHiddenUsersSet()
  const visible = ranked.filter((m) => !hidden.has(m)).slice(0, safeLimit)
  if (visible.length === 0) return []

  const [profiles, sold, eth, usdc] = await Promise.all([
    getProfileBatch(visible),
    scoresFor(STATS_SOLD_KEY, visible),
    scoresFor(STATS_EARNED_ETH_KEY, visible),
    scoresFor(STATS_EARNED_USDC_KEY, visible),
  ])

  return visible.map((address) => {
    const p = profiles.get(address)
    return {
      address,
      username: p?.username,
      avatarUrl: p?.avatarUrl,
      sold: sold.get(address) ?? 0,
      earnedEth: eth.get(address) ?? 0,
      earnedUsdc: usdc.get(address) ?? 0,
    }
  })
}

/** Single-artist totals, e.g. for a public stats strip on a profile. */
export async function getArtistStats(
  artist: string,
): Promise<{ sold: number; earnedEth: number; earnedUsdc: number }> {
  const member = artist.toLowerCase()
  try {
    const [sold, eth, usdc] = await Promise.all([
      redis.zscore(STATS_SOLD_KEY, member),
      redis.zscore(STATS_EARNED_ETH_KEY, member),
      redis.zscore(STATS_EARNED_USDC_KEY, member),
    ])
    return {
      sold: Number(sold ?? 0),
      earnedEth: Number(eth ?? 0),
      earnedUsdc: Number(usdc ?? 0),
    }
  } catch {
    return { sold: 0, earnedEth: 0, earnedUsdc: 0 }
  }
}
