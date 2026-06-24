import { redis } from './redis'
import { getEthUsd } from './ethPrice'
import { inferCollectCurrency } from './inprocess'
import { fetchTransfersPage, type TransferItem } from './inprocessTransfers'
import { expandToFidSiblings } from './addressUnion'
import type { EarningsAmounts } from './earningsFormat'

// Per-artist primary-sale stats, rebuilt from the In•Process /transfers feed
// (the canonical, complete, historical record — see rebuildStats). Native ETH
// and USDC totals are the stable truth (one sorted set each, keyed by artist);
// USD is derived at read time. Paid mints live in a third set; free mints are
// excluded upstream (type=payment) and here.
const MINTS_KEY = 'kismetart:stats:mints'
const ETH_KEY = 'kismetart:stats:earned:eth'
const USDC_KEY = 'kismetart:stats:earned:usdc'

// Per-artist SECONDARY-sale royalty earnings (creator royalty on Seaport resales),
// in human units keyed by artist. SEPARATE from the earned:* sets above on
// purpose: those are rebuilt with absolute ZADDs from /transfers (rebuildStats),
// which would wipe any royalties merged in. Royalties are event-driven instead —
// incremented once per fill from the on-chain-verified PATCH handler
// (creditListingRoyalty) — so they accrue forward and are never rebuilt.
const ROYALTY_ETH_KEY = 'kismetart:stats:royalty:eth'
const ROYALTY_USDC_KEY = 'kismetart:stats:royalty:usdc'
// One-time idempotency claim per filled listing so a retried/concurrent fill
// credits exactly once (ZINCRBY is not idempotent).
const royaltyCreditedKey = (listingId: string) => `kismetart:royalty-credited:${listingId}`

export interface ArtistEarnings {
  address: string
  // Totals = primary (mints) + secondary (listing royalties).
  eth: number
  usdc: number
  usd: number
  mints: number
  // Source split of the totals, so the card can show "mints vs resales".
  primary: EarningsAmounts
  secondary: EarningsAmounts
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

// Single-artist earnings for the profile card. Unioned across the artist's
// Farcaster sibling wallets (expandToFidSiblings) — the SAME identity model the
// timeline uses for their mints/collects — so earnings reflect every wallet they
// sold from, not just the one the profile canonicalizes to. Without the union an
// FC artist who minted from one wallet but whose profile resolves to another
// reads 0 and the card vanishes despite real sales. A non-FC artist resolves to
// [self], so this is a no-op (one zscore per key) for them. Pass `wallets` to
// reuse a sibling set the caller already resolved (e.g. /api/stats shares one
// resolution across this and the pending roll-up). Returns primary (mint) and
// secondary (listing-royalty) earnings both separately and summed into the total.
// Visibility gating is applied by the callers, not here — this is the raw read.
export async function getArtistEarnings(artist: string, wallets?: string[]): Promise<ArtistEarnings> {
  const lower = artist.toLowerCase()
  try {
    const ws = wallets ?? (await expandToFidSiblings(lower))
    // 5 keys × N wallets of zscore plus the price, all issued in one tick so
    // Upstash auto-pipelining collapses them into a single round trip (N = the
    // sibling count, usually 1). Primary (mints) and secondary (royalties) are
    // summed separately so the card can break them out, then added for the total.
    const [pEth, pUsdc, mints, rEth, rUsdc, ethUsd] = await Promise.all([
      Promise.all(ws.map((w) => redis.zscore(ETH_KEY, w))),
      Promise.all(ws.map((w) => redis.zscore(USDC_KEY, w))),
      Promise.all(ws.map((w) => redis.zscore(MINTS_KEY, w))),
      Promise.all(ws.map((w) => redis.zscore(ROYALTY_ETH_KEY, w))),
      Promise.all(ws.map((w) => redis.zscore(ROYALTY_USDC_KEY, w))),
      getEthUsd(),
    ])
    const sum = (xs: unknown[]) => xs.reduce<number>((acc, x) => acc + Number(x ?? 0), 0)
    const price = ethUsd ?? 0
    const primEth = sum(pEth)
    const primUsdc = sum(pUsdc)
    const royEth = sum(rEth)
    const royUsdc = sum(rUsdc)
    const eth = primEth + royEth
    const usdc = primUsdc + royUsdc
    return {
      address: lower,
      eth,
      usdc,
      usd: eth * price + usdc,
      mints: sum(mints),
      primary: { eth: primEth, usdc: primUsdc, usd: primEth * price + primUsdc },
      secondary: { eth: royEth, usdc: royUsdc, usd: royEth * price + royUsdc },
    }
  } catch {
    const zero = (): EarningsAmounts => ({ eth: 0, usdc: 0, usd: 0 })
    return { address: lower, eth: 0, usdc: 0, usd: 0, mints: 0, primary: zero(), secondary: zero() }
  }
}

// Credit a secondary-sale creator royalty to the artist who earned it. Called
// once per fill from the on-chain-verified listings PATCH handler with the royalty
// amount actually paid on-chain (human units). Royalties are configured
// COLLECTION-WIDE — one EIP-2981 receiver + BPS per contract, set at deploy — and
// are NOT the moment's per-token primary split; so the whole amount is credited
// to that single receiver, the address the royalty is actually paid to on-chain.
// The receiver defaults to the collection creator, so it surfaces on their card
// via the sibling union; a creator who pointed royalties at a collaborator or a
// split contract has it accrue there instead. Idempotent per listing via an NX
// claim so a retried/concurrent fill can't double-count. Best-effort — never
// fails the sale.
export async function creditListingRoyalty(args: {
  listingId: string
  currency: 'eth' | 'usdc'
  amount: number
  receiver: string
}): Promise<void> {
  const { listingId, currency, amount, receiver } = args
  if (!Number.isFinite(amount) || amount <= 0) return
  const member = receiver.toLowerCase()
  if (!member) return
  try {
    const claimed = await redis.set(royaltyCreditedKey(listingId), '1', { nx: true })
    if (claimed !== 'OK') return // already credited (retry / concurrent fill)
    const key = currency === 'usdc' ? ROYALTY_USDC_KEY : ROYALTY_ETH_KEY
    await redis.zincrby(key, amount, member)
  } catch {
    // Swallow — royalty stats are best-effort and must never fail the sale.
  }
}
