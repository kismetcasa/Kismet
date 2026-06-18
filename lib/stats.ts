import { redis } from './redis'
import { getProfileBatch } from './profile'
import { getHiddenUsersSet } from './hidden-users'
import { getEthUsd } from './ethPrice'
import { inferCollectCurrency } from './inprocess'
import { fetchTransfersPage, type TransferItem } from './inprocessTransfers'
import type { EarningsMetric } from './earningsFormat'

// ─── Artist sales stats (PRIMARY, PAID SALES) ────────────────────────────────
//
// Source of truth: the In•Process /transfers feed (the canonical, complete,
// historical on-chain record), aggregated by a periodic rebuild — NOT a live
// counter. `type=payment` means free airdrops are excluded upstream. Two figures
// per artist:
//
//   - mints    → count of paid editions, attributed to the moment's creator
//   - earnings → split-aware share of each sale's `value`, kept NATIVE per
//                currency (total ETH and total USDC, stored separately). These
//                are the stable, realized truth — they never move. USD is
//                DERIVED at read time (getEthUsd): a current market-value lens,
//                so its drift is fenced into that one view.
//
// Storage: native ETH/USDC totals + paid-mint counts in three sorted sets, so
// each doubles as a leaderboard (ZREVRANGE) and a per-artist lookup (ZSCORE).
// rebuildStats writes ABSOLUTE totals with ZADD, so every run recomputes from
// scratch — idempotent, self-healing (drift can't accumulate), and it backfills
// all history in the same pass. Scores are float64: exact for the integer mint
// count, ~15 sig-figs for the running ETH/USDC totals — plenty for rank/display.
const STATS_MINTS_KEY = 'kismetart:stats:mints'
const STATS_EARNED_ETH_KEY = 'kismetart:stats:earned:eth'
const STATS_EARNED_USDC_KEY = 'kismetart:stats:earned:usdc'

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

// ── Rebuild from the /transfers feed ─────────────────────────────────────────

// Hard cap so a runaway/huge feed can't loop forever. 1000 pages × 100 = 100k
// transfers per rebuild; raise it (or switch to an incremental sync) if the
// platform outgrows that.
const MAX_REBUILD_PAGES = 1000

const bump = (m: Map<string, number>, key: string, by: number) =>
  m.set(key, (m.get(key) ?? 0) + by)

/** Coerce a JSON number — or a numeric string, which some APIs use for decimal
 *  amounts — to a finite number; anything else → 0. */
const toNum = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

/**
 * Fold one transfer into the running aggregates. Returns 1 if counted, 0 if
 * skipped (unpaid / free).
 *
 * `value` is the human-denominated amount paid (matching the /payments `amount`
 * convention). Mints go to the moment's creator; earnings are split across
 * `fee_recipients` by `percent_allocation`, falling back to the creator at 100%
 * when no split is present.
 */
function accumulateTransfer(
  t: TransferItem,
  mints: Map<string, number>,
  eth: Map<string, number>,
  usdc: Map<string, number>,
): 0 | 1 {
  const value = toNum(t.value)
  if (!(value > 0)) return 0 // free / airdrop — excluded (type=payment already filters)

  const q = toNum(t.quantity)
  const quantity = q > 0 ? Math.floor(q) : 1
  const earned = inferCollectCurrency({ currency: t.currency ?? undefined }) === 'usdc' ? usdc : eth
  // Creator: schema returns collection.artist.{address}; the doc example returns
  // collection.creator as a bare string. Accept either.
  const col = t.moment?.collection
  const creator = (col?.artist?.address ?? col?.creator)?.toLowerCase()

  if (creator) bump(mints, creator, quantity)

  const recipients = t.moment?.fee_recipients
  if (Array.isArray(recipients) && recipients.length > 0) {
    for (const r of recipients) {
      const addr = (r.artist_address ?? r.address)?.toLowerCase()
      const pct = toNum(r.percent_allocation)
      if (addr && pct > 0) bump(earned, addr, (value * pct) / 100)
    }
  } else if (creator) {
    bump(earned, creator, value)
  }
  return 1
}

/** Write absolute per-artist totals. ZADD overwrites each member's score, so the
 *  rebuild is idempotent + self-healing. Chunked + auto-pipelined; the earner
 *  set is small (only artists with paid sales). */
async function writeZsetAbsolute(key: string, m: Map<string, number>): Promise<void> {
  const entries = Array.from(m.entries()).filter(([, v]) => v > 0)
  for (let i = 0; i < entries.length; i += 500) {
    await Promise.all(
      entries.slice(i, i + 500).map(([member, score]) => redis.zadd(key, { score, member })),
    )
  }
}

/**
 * Rebuild every artist's stats from the /transfers feed. Idempotent and
 * self-healing: writes absolute totals, so a run fully reconciles the board
 * (and backfills history) regardless of prior state. Drive it from the cron
 * route, or call once for the initial backfill.
 */
export async function rebuildStats(): Promise<{ artists: number; transfers: number; pages: number }> {
  const mints = new Map<string, number>()
  const eth = new Map<string, number>()
  const usdc = new Map<string, number>()

  let page = 1
  let totalPages = 1
  let counted = 0
  do {
    const res = await fetchTransfersPage({ type: 'payment', chainId: 8453, page, limit: 100 })
    // Abort on a failed fetch rather than write a truncated set over good
    // totals — a transient blip then preserves the last complete rebuild.
    if (!res) throw new Error(`transfers fetch failed at page ${page}`)
    for (const t of res.transfers) counted += accumulateTransfer(t, mints, eth, usdc)
    totalPages = res.pagination.total_pages || 1
    page++
  } while (page <= totalPages && page <= MAX_REBUILD_PAGES)

  await Promise.all([
    writeZsetAbsolute(STATS_MINTS_KEY, mints),
    writeZsetAbsolute(STATS_EARNED_ETH_KEY, eth),
    writeZsetAbsolute(STATS_EARNED_USDC_KEY, usdc),
  ])

  const artists = new Set<string>([...mints.keys(), ...eth.keys(), ...usdc.keys()])
  return { artists: artists.size, transfers: counted, pages: page - 1 }
}

// ── Reads ────────────────────────────────────────────────────────────────────

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
