import { redis } from './redis'
import { getEthUsd } from './ethPrice'
import { inferCollectCurrency } from './inprocess'
import { fetchTransfersPage, type TransferItem } from './inprocessTransfers'

// Per-artist primary-sale stats, rebuilt from the In•Process /transfers feed
// (the canonical, complete, historical record — see rebuildStats). Native ETH
// and USDC totals are the stable truth (one sorted set each, keyed by artist);
// USD is derived at read time. Paid mints live in a third set; free mints are
// excluded upstream (type=payment) and here.
const MINTS_KEY = 'kismetart:stats:mints'
const ETH_KEY = 'kismetart:stats:earned:eth'
const USDC_KEY = 'kismetart:stats:earned:usdc'

export interface ArtistEarnings {
  address: string
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

// ZADD absolute (overwrite) so each run is idempotent + self-healing. One
// multi-member ZADD per chunk — Upstash bills per command, so batching the whole
// earner set keeps a rebuild to ~3 commands, not ~3×artists.
async function writeZset(key: string, m: Map<string, number>): Promise<void> {
  const entries = [...m].filter(([, v]) => v > 0).map(([member, score]) => ({ score, member }))
  for (let i = 0; i < entries.length; i += 1000) {
    const chunk = entries.slice(i, i + 1000)
    if (chunk.length) await redis.zadd(key, chunk[0], ...chunk.slice(1))
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
