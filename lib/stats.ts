import { formatEther, formatUnits } from 'viem'
import { redis } from './redis'
import { getProfileBatch } from './profile'
import { getHiddenUsersSet } from './hidden-users'
import { getEthUsd } from './ethPrice'
import type { EarningsMetric } from './earningsFormat'

// ─── Artist sales stats (PRIMARY, PAID SALES ONLY) ───────────────────────────
//
// Scope is deliberately narrow: primary mints/collects only — no secondary
// (Seaport) sales, no split payouts. Two figures per artist (attributed to the
// moment's creator), and FREE MINTS ARE EXCLUDED FROM BOTH:
//
//   - mints    → count of PAID primary editions (a free mint counts for nothing)
//   - earnings → gross sale price, kept NATIVE per currency: total ETH and total
//                USDC, stored separately. These are the stable, realized truth —
//                they never move. USD is DERIVED (see getEthUsd): a current
//                market-value lens, not a stored "earning", so its drift is
//                fenced into that one view.
//
// Storage: native ETH and USDC totals live in two sorted sets (so each is also a
// stable per-currency leaderboard), paid-mint counts in a third. ZINCRBY keeps
// updates atomic — same pattern as TRENDING_KEY. Scores are float64: exact for
// the integer mint count up to 2^53, ~15 sig-figs for the running ETH/USDC
// totals — plenty for ranking + display. The USD ranking can't live in a zset
// (it's a function of a moving price), so getEarningsLeaderboard merges the two
// native sets and computes USD on read with one cached price. That set is small
// (only artists with paid sales appear), so a full load + in-memory sort is the
// simplest effective approach; promote to a periodically-rescored usd zset only
// if the earner count ever gets large.
export const STATS_MINTS_KEY = 'kismetart:stats:mints'
export const STATS_EARNED_ETH_KEY = 'kismetart:stats:earned:eth'
export const STATS_EARNED_USDC_KEY = 'kismetart:stats:earned:usdc'

export type { EarningsMetric }

export interface ArtistEarnings {
  address: string
  username?: string
  avatarUrl?: string
  /** Total native ETH earned from paid primary sales (whole ETH). */
  eth: number
  /** Total native USDC earned from paid primary sales (whole USDC). */
  usdc: number
  /** Derived current USD value: eth × ETH/USD + usdc. Moves with ETH price. */
  usd: number
  /** Count of paid primary editions (free mints excluded). */
  mints: number
}

/**
 * Record a single verified PAID primary sale against the artist (the moment's
 * creator). Call ONLY from a path that has already verified the mint on-chain
 * and is idempotency-gated (e.g. /api/collect) so a sale is never double
 * counted. `pricePerToken` is per-edition base units (wei for ETH, 6dp for
 * USDC). Free mints (no price / zero total) and unknown-currency mints are
 * excluded from BOTH the mint count and earnings. Best-effort — never throws.
 */
export async function recordPrimarySale(params: {
  artist: string
  amount: number
  pricePerToken?: string | null
  currency?: 'eth' | 'usdc'
}): Promise<void> {
  const { artist, amount, pricePerToken, currency } = params
  if (!artist || !/^0x[0-9a-fA-F]{40}$/.test(artist)) return
  // Need a known price AND currency to classify this as a paid sale and bucket
  // it; without both we can't tell free from paid, so we don't record.
  if (!pricePerToken || !currency) return

  const editions = Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 1
  let total: bigint
  try {
    total = BigInt(pricePerToken) * BigInt(editions)
  } catch {
    return
  }
  if (total <= 0n) return // free mint — excluded from count + earnings

  const whole = currency === 'eth' ? Number(formatEther(total)) : Number(formatUnits(total, 6))
  if (!Number.isFinite(whole) || whole <= 0) return

  const member = artist.toLowerCase()
  try {
    await Promise.all([
      redis.zincrby(STATS_MINTS_KEY, editions, member),
      redis.zincrby(
        currency === 'eth' ? STATS_EARNED_ETH_KEY : STATS_EARNED_USDC_KEY,
        whole,
        member,
      ),
    ])
  } catch {
    // Stats are non-critical — swallow so the collect recording never breaks.
  }
}

/** ZSCORE a set of members in one (auto-pipelined) round trip. Missing → 0. */
async function scoresFor(key: string, members: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (members.length === 0) return out
  try {
    const scores = await Promise.all(members.map((m) => redis.zscore(key, m)))
    members.forEach((m, i) => {
      const s = scores[i]
      if (s !== null && s !== undefined && Number.isFinite(Number(s))) out.set(m, Number(s))
    })
  } catch {
    // leave empty — callers treat a missing score as 0
  }
  return out
}

/**
 * Top artists by `metric`. ETH/USDC rank on the stable native totals; USD ranks
 * on the derived current value (eth × price + usdc) using one cached ETH/USD
 * read. Every row carries all three earnings figures + the paid-mint count so
 * the UI can toggle denomination without refetching. Admin-hidden users are
 * stripped (same public-feed gate as search / payments).
 */
export async function getEarningsLeaderboard(
  metric: EarningsMetric,
  limit = 50,
): Promise<ArtistEarnings[]> {
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit) || 50))

  let ethRaw: (string | number)[]
  let usdcRaw: (string | number)[]
  try {
    [ethRaw, usdcRaw] = await Promise.all([
      redis.zrange(STATS_EARNED_ETH_KEY, 0, -1, { withScores: true }) as Promise<(string | number)[]>,
      redis.zrange(STATS_EARNED_USDC_KEY, 0, -1, { withScores: true }) as Promise<(string | number)[]>,
    ])
  } catch {
    return []
  }

  // Merge the two native sets (withScores → flat [member, score, …]).
  const merged = new Map<string, { eth: number; usdc: number }>()
  for (let i = 0; i < ethRaw.length; i += 2) {
    merged.set(String(ethRaw[i]).toLowerCase(), { eth: Number(ethRaw[i + 1]) || 0, usdc: 0 })
  }
  for (let i = 0; i < usdcRaw.length; i += 2) {
    const a = String(usdcRaw[i]).toLowerCase()
    const cur = merged.get(a) ?? { eth: 0, usdc: 0 }
    cur.usdc = Number(usdcRaw[i + 1]) || 0
    merged.set(a, cur)
  }
  if (merged.size === 0) return []

  const [ethUsd, hidden] = await Promise.all([getEthUsd(), getHiddenUsersSet()])
  const price = ethUsd ?? 0

  let rows = Array.from(merged.entries())
    .filter(([address]) => !hidden.has(address))
    .map(([address, v]) => ({
      address,
      eth: v.eth,
      usdc: v.usdc,
      usd: v.eth * price + v.usdc,
      mints: 0,
    }))

  rows.sort((a, b) =>
    metric === 'eth' ? b.eth - a.eth : metric === 'usdc' ? b.usdc - a.usdc : b.usd - a.usd,
  )
  rows = rows.slice(0, safeLimit)

  const addrs = rows.map((r) => r.address)
  const [profiles, mints] = await Promise.all([getProfileBatch(addrs), scoresFor(STATS_MINTS_KEY, addrs)])
  return rows.map((r) => {
    const p = profiles.get(r.address)
    return { ...r, username: p?.username, avatarUrl: p?.avatarUrl, mints: mints.get(r.address) ?? 0 }
  })
}

/** Single-artist earnings, e.g. for the public profile stat strip + share card. */
export async function getArtistEarnings(artist: string): Promise<ArtistEarnings> {
  const member = artist.toLowerCase()
  try {
    const [eth, usdc, mints, ethUsd] = await Promise.all([
      redis.zscore(STATS_EARNED_ETH_KEY, member),
      redis.zscore(STATS_EARNED_USDC_KEY, member),
      redis.zscore(STATS_MINTS_KEY, member),
      getEthUsd(),
    ])
    const e = Number(eth ?? 0)
    const u = Number(usdc ?? 0)
    return { address: member, eth: e, usdc: u, usd: e * (ethUsd ?? 0) + u, mints: Number(mints ?? 0) }
  } catch {
    return { address: member, eth: 0, usdc: 0, usd: 0, mints: 0 }
  }
}
