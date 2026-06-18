import { redis } from './redis'
import { getProfileBatch } from './profile'
import { getHiddenUsersSet } from './hidden-users'
import { getEthUsd } from './ethPrice'
import { getPublicEarners } from './earningsVisibility'
import { inferCollectCurrency } from './inprocess'
import { fetchTransfersPage, type TransferItem } from './inprocessTransfers'
import type { EarningsMetric } from './earningsFormat'

// Per-artist primary-sale stats, rebuilt from the In•Process /transfers feed
// (the canonical, complete, historical record — see rebuildStats). Native ETH
// and USDC totals are the stable truth: two sorted sets, each doubling as a
// leaderboard + per-artist lookup. USD is derived at read time. Paid mints live
// in a third set; free mints are excluded upstream (type=payment) and here.
const MINTS_KEY = 'kismetart:stats:mints'
const ETH_KEY = 'kismetart:stats:earned:eth'
const USDC_KEY = 'kismetart:stats:earned:usdc'

export interface ArtistEarnings {
  address: string
  username?: string
  avatarUrl?: string
  eth: number
  usdc: number
  usd: number
  mints: number
}

// ── Rebuild ──────────────────────────────────────────────────────────────────

const MAX_PAGES = 1000 // 100k transfers; move to an incremental sync beyond that
const bump = (m: Map<string, number>, k: string, by: number) => m.set(k, (m.get(k) ?? 0) + by)

// Fold one paid transfer into the aggregates: mints → the moment creator;
// earnings → split across fee_recipients (else the creator at 100%), native per
// currency. Returns 1 if counted.
function accumulate(
  t: TransferItem,
  mints: Map<string, number>,
  eth: Map<string, number>,
  usdc: Map<string, number>,
): 0 | 1 {
  const value = typeof t.value === 'number' ? t.value : 0
  if (value <= 0) return 0
  const qty = typeof t.quantity === 'number' && t.quantity > 0 ? Math.floor(t.quantity) : 1
  const earned = inferCollectCurrency({ currency: t.currency ?? undefined }) === 'usdc' ? usdc : eth
  const creator = (t.moment?.collection?.artist?.address ?? t.moment?.collection?.creator)?.toLowerCase()
  if (creator) bump(mints, creator, qty)

  const recipients = t.moment?.fee_recipients
  if (recipients?.length) {
    for (const r of recipients) {
      const addr = r.artist_address?.toLowerCase()
      const pct = typeof r.percent_allocation === 'number' ? r.percent_allocation : 0
      if (addr && pct > 0) bump(earned, addr, (value * pct) / 100)
    }
  } else if (creator) {
    bump(earned, creator, value)
  }
  return 1
}

// ZADD absolute (overwrite) so each run is idempotent + self-healing; chunked.
async function writeZset(key: string, m: Map<string, number>): Promise<void> {
  const entries = [...m].filter(([, v]) => v > 0)
  for (let i = 0; i < entries.length; i += 500) {
    await Promise.all(entries.slice(i, i + 500).map(([member, score]) => redis.zadd(key, { score, member })))
  }
}

// Rebuild all stats from /transfers. Idempotent, self-healing, backfills history.
// Aborts (throws) on a fetch failure so a partial scan never overwrites good
// totals. Drive from the cron route, or call once to backfill.
export async function rebuildStats(): Promise<{ artists: number; transfers: number; pages: number }> {
  const mints = new Map<string, number>()
  const eth = new Map<string, number>()
  const usdc = new Map<string, number>()
  let page = 1
  let totalPages = 1
  let counted = 0
  do {
    const res = await fetchTransfersPage(page)
    if (!res) throw new Error(`transfers fetch failed at page ${page}`)
    for (const t of res.transfers) counted += accumulate(t, mints, eth, usdc)
    totalPages = res.pagination.total_pages || 1
    page++
  } while (page <= totalPages && page <= MAX_PAGES)

  await Promise.all([writeZset(MINTS_KEY, mints), writeZset(ETH_KEY, eth), writeZset(USDC_KEY, usdc)])
  return {
    artists: new Set([...mints.keys(), ...eth.keys(), ...usdc.keys()]).size,
    transfers: counted,
    pages: page - 1,
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

async function scores(key: string, members: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (members.length === 0) return out
  try {
    const s = await Promise.all(members.map((m) => redis.zscore(key, m)))
    members.forEach((m, i) => {
      const v = Number(s[i])
      if (Number.isFinite(v)) out.set(m, v)
    })
  } catch {}
  return out
}

// Top artists by metric. ETH/USDC rank on the stable native totals; USD on the
// derived value (one cached price). Only artists who pinned earnings public are
// included (same gate as the card + share); admin-hidden users stripped.
export async function getEarningsLeaderboard(metric: EarningsMetric, limit = 50): Promise<ArtistEarnings[]> {
  const n = Math.min(100, Math.max(1, Math.floor(limit) || 50))
  let ethRaw: (string | number)[]
  let usdcRaw: (string | number)[]
  try {
    [ethRaw, usdcRaw] = await Promise.all([
      redis.zrange(ETH_KEY, 0, -1, { withScores: true }) as Promise<(string | number)[]>,
      redis.zrange(USDC_KEY, 0, -1, { withScores: true }) as Promise<(string | number)[]>,
    ])
  } catch {
    return []
  }

  // withScores → flat [member, score, …]; merge the two native sets.
  const merged = new Map<string, { eth: number; usdc: number }>()
  for (let i = 0; i < ethRaw.length; i += 2) {
    merged.set(String(ethRaw[i]).toLowerCase(), { eth: Number(ethRaw[i + 1]) || 0, usdc: 0 })
  }
  for (let i = 0; i < usdcRaw.length; i += 2) {
    const a = String(usdcRaw[i]).toLowerCase()
    merged.set(a, { eth: merged.get(a)?.eth ?? 0, usdc: Number(usdcRaw[i + 1]) || 0 })
  }
  if (merged.size === 0) return []

  const [ethUsd, hidden, isPublic] = await Promise.all([getEthUsd(), getHiddenUsersSet(), getPublicEarners()])
  const price = ethUsd ?? 0
  const rows = [...merged.entries()]
    .filter(([a]) => isPublic.has(a) && !hidden.has(a))
    .map(([address, v]) => ({ address, eth: v.eth, usdc: v.usdc, usd: v.eth * price + v.usdc, mints: 0 }))
    .sort((a, b) => (metric === 'eth' ? b.eth - a.eth : metric === 'usdc' ? b.usdc - a.usdc : b.usd - a.usd))
    .slice(0, n)

  const addrs = rows.map((r) => r.address)
  const [profiles, mints] = await Promise.all([getProfileBatch(addrs), scores(MINTS_KEY, addrs)])
  return rows.map((r) => {
    const p = profiles.get(r.address)
    return { ...r, username: p?.username, avatarUrl: p?.avatarUrl, mints: mints.get(r.address) ?? 0 }
  })
}

// Single-artist earnings for the profile card. Visibility gating is applied by
// the /api/stats route, not here — this is the raw read.
export async function getArtistEarnings(artist: string): Promise<ArtistEarnings> {
  const m = artist.toLowerCase()
  try {
    const [eth, usdc, mints, ethUsd] = await Promise.all([
      redis.zscore(ETH_KEY, m),
      redis.zscore(USDC_KEY, m),
      redis.zscore(MINTS_KEY, m),
      getEthUsd(),
    ])
    const e = Number(eth ?? 0)
    const u = Number(usdc ?? 0)
    return { address: m, eth: e, usdc: u, usd: e * (ethUsd ?? 0) + u, mints: Number(mints ?? 0) }
  } catch {
    return { address: m, eth: 0, usdc: 0, usd: 0, mints: 0 }
  }
}
