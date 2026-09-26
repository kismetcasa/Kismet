// Independent oracle for the sweep index's pure half — lib/sweepIndexCore.ts and
// lib/sweepRank.ts — and the shared mintability rules it reuses from
// lib/saleConfig (classifyOnchainSaleWindow / classifyTokenSupply, which
// fetchEligibleTokens now calls too, so a drift here would also move the
// collect-all / agent / scout pre-flight).
//
// WHAT IT GUARDS (SWEEP_IMPLEMENTATION.md §2, §7):
//   - the window rule (saleEnd==0 is UNSET, ended beats scheduled, the
//     open-ended max-uint64 sentinel is live) and the supply rule (capped +
//     exhausted = sold out; open / unreadable = never sold out);
//   - admission: only LIVE + PAID rows become items; a collection with no
//     in-bounds mint fee is dropped (fail-closed); sold out is dropped;
//   - ranking: outlay ascending (price + fee), artist interleave inside a
//     price tier (one wallet with many equal-priced pieces can never fill a
//     tier while another artist is there), newest-first within an artist,
//     unattributed items never grouped, deterministic for any input order;
//     the DORMANT options (perArtist, floorWei) behave as documented;
//   - the pool cut, the serve prefix (3n floored at 30), the ?n= clamp, the
//     serve-time hide filters, and the Moment projection /api/sweep enriches.
// Run: node --experimental-strip-types --import ./scripts/register-ts-alias.mjs scripts/verify-sweep.ts

import { classifyOnchainSaleWindow, classifyTokenSupply } from '../lib/saleConfig.ts'
import { rankSweepCandidates, type RankableSweepItem } from '../lib/sweepRank.ts'
import {
  SWEEP_DEFAULT_N,
  SWEEP_MAX_N,
  SWEEP_POOL_SIZE,
  SWEEP_SERVE_MIN,
  buildSweepItem,
  clampSweepN,
  finalizeSweepIndex,
  isLivePaidSale,
  selectSweepItems,
  serveCount,
  sweepItemToMoment,
  sweepKey,
  type SweepCandidate,
  type SweepIndexItem,
} from '../lib/sweepIndexCore.ts'
import { MAX_COLLECT_ALL_BATCH, OPEN_EDITION_MINT_SIZE } from '../lib/zoraMint.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

const NOW = 1_800_000_000n
const FEE = 111_000_000_000_000n // Zora's protocol mint fee, 0.000111 ETH
const OPEN = OPEN_EDITION_MINT_SIZE
const COL_A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' // mixed case → items must lowercase
const COL_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const ART_1 = '0x1111111111111111111111111111111111111111'
const ART_2 = '0x2222222222222222222222222222222222222222'
const ART_3 = '0x3333333333333333333333333333333333333333'

function sale(price: bigint, opts: { start?: bigint; end?: bigint; maxPer?: bigint } = {}) {
  return {
    saleStart: opts.start ?? 0n,
    saleEnd: opts.end ?? OPEN,
    maxTokensPerAddress: opts.maxPer ?? 0n,
    pricePerToken: price,
  }
}
function cand(
  tokenId: string,
  artist: string | null,
  createdAt: string | null = '2026-09-01T00:00:00Z',
  extra: Partial<SweepCandidate> = {},
): SweepCandidate {
  return { address: COL_A, tokenId, creator: artist, artist, createdAt, ...extra }
}
function rk(
  id: string,
  outlayWei: bigint,
  artist: string | null,
  createdAtMs: number | null,
): RankableSweepItem {
  return { address: COL_A, tokenId: id, outlayWei, artist, createdAtMs }
}
function idx(over: Partial<SweepIndexItem> & { tokenId: string }): SweepIndexItem {
  return {
    address: COL_A.toLowerCase(),
    priceWei: '1000',
    feeWei: FEE.toString(),
    outlayWei: (1000n + FEE).toString(),
    maxPerAddress: '0',
    remaining: null,
    saleEnd: OPEN.toString(),
    creator: ART_1,
    artist: ART_1,
    createdAt: '2026-09-01T00:00:00Z',
    ...over,
  }
}
// Deterministic PRNG so a property failure reproduces.
let seed = 0x9e3779b9
const rand = (): number => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed / 0x1_0000_0000
}
const shuffle = <T,>(arr: readonly T[]): T[] => {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
const keys = (items: readonly { address: string; tokenId: string }[]) =>
  items.map((i) => sweepKey(i.address, i.tokenId))

// ── 1. window rule ──────────────────────────────────────────────────────────
console.log('classifyOnchainSaleWindow')
check('saleEnd 0 is UNSET, never "no deadline"', classifyOnchainSaleWindow({ saleStart: 0n, saleEnd: 0n }, NOW) === 'unset')
check('saleEnd == now is ended', classifyOnchainSaleWindow({ saleStart: 0n, saleEnd: NOW }, NOW) === 'ended')
check('saleEnd < now is ended', classifyOnchainSaleWindow({ saleStart: 0n, saleEnd: NOW - 1n }, NOW) === 'ended')
check('saleStart > now is scheduled', classifyOnchainSaleWindow({ saleStart: NOW + 1n, saleEnd: NOW + 100n }, NOW) === 'scheduled')
check('saleStart == now is live', classifyOnchainSaleWindow({ saleStart: NOW, saleEnd: NOW + 1n }, NOW) === 'live')
check('open-ended sentinel is live', classifyOnchainSaleWindow({ saleStart: 0n, saleEnd: OPEN }, NOW) === 'live')
check('malformed end<start reads as ended, not scheduled', classifyOnchainSaleWindow({ saleStart: NOW + 10n, saleEnd: NOW - 10n }, NOW) === 'ended')

// ── 2. supply rule ──────────────────────────────────────────────────────────
console.log('classifyTokenSupply')
{
  const u = classifyTokenSupply(null)
  check('unreadable row is never sold out and carries no remaining', !u.soldOut && u.remaining === undefined)
  const o0 = classifyTokenSupply({ maxSupply: 0n, totalMinted: 5n })
  check('maxSupply 0 is an open edition', !o0.soldOut && o0.remaining === undefined)
  const oS = classifyTokenSupply({ maxSupply: OPEN, totalMinted: 5n })
  check('max-uint64 sentinel is an open edition', !oS.soldOut && oS.remaining === undefined)
  const room = classifyTokenSupply({ maxSupply: 10n, totalMinted: 7n })
  check('capped with room → remaining = max − minted', !room.soldOut && room.remaining === 3n)
  const full = classifyTokenSupply({ maxSupply: 10n, totalMinted: 10n })
  check('capped + exhausted → sold out, remaining 0', full.soldOut && full.remaining === 0n)
  check('over-minted (burn/reissue edge) → sold out', classifyTokenSupply({ maxSupply: 10n, totalMinted: 12n }).soldOut)
}

// ── 3. admission ────────────────────────────────────────────────────────────
console.log('isLivePaidSale / buildSweepItem')
check('null row is not live+paid', !isLivePaidSale(null, NOW))
check('FREE live row is excluded (price 0)', !isLivePaidSale(sale(0n), NOW))
check('paid live row is admitted', isLivePaidSale(sale(1n), NOW))
check('paid but ended is excluded', !isLivePaidSale(sale(1n, { end: NOW }), NOW))
check('paid but scheduled is excluded', !isLivePaidSale(sale(1n, { start: NOW + 1n }), NOW))
check('unset row (all zeros) is excluded', !isLivePaidSale(sale(0n, { end: 0n }), NOW))
{
  const c = cand('7', ART_1, '2026-09-02T00:00:00Z', { name: 'Dawn', image: 'ar://img', thumbhash: 'th' })
  check('no in-bounds fee for the collection → dropped (fail-closed)', buildSweepItem(c, sale(1000n), null, undefined, NOW) === null)
  check('sold out → dropped', buildSweepItem(c, sale(1000n), { maxSupply: 5n, totalMinted: 5n }, FEE, NOW) === null)
  check('free → dropped even with a fee', buildSweepItem(c, sale(0n), null, FEE, NOW) === null)
  const open = buildSweepItem(c, sale(1000n, { maxPer: 2n }), null, FEE, NOW)
  check('admitted: address lowercased', open?.address === COL_A.toLowerCase())
  check('admitted: tokenId carried', open?.tokenId === '7')
  check('admitted: priceWei / feeWei / outlayWei = price + fee', open?.priceWei === '1000' && open?.feeWei === FEE.toString() && open?.outlayWei === (1000n + FEE).toString())
  check('admitted: maxPerAddress carried as a string', open?.maxPerAddress === '2')
  check('admitted: unreadable supply → remaining null', open?.remaining === null)
  check('admitted: saleEnd preserves the sentinel', open?.saleEnd === OPEN.toString())
  check('admitted: creator / artist / createdAt pass through', open?.creator === ART_1 && open?.artist === ART_1 && open?.createdAt === '2026-09-02T00:00:00Z')
  check('admitted: preview fields carried', open?.name === 'Dawn' && open?.image === 'ar://img' && open?.thumbhash === 'th')
  const capped = buildSweepItem(cand('8', ART_2), sale(5n), { maxSupply: 10n, totalMinted: 7n }, FEE, NOW)
  check('capped edition → remaining "3"', capped?.remaining === '3')
  const bare = buildSweepItem(cand('9', null, null), sale(5n), { maxSupply: 0n, totalMinted: 1n }, FEE, NOW)
  check('no preview fields → keys absent, not undefined-valued', !!bare && !('name' in bare) && !('image' in bare) && !('thumbhash' in bare))
  check('unattributed candidate → creator/artist null, createdAt null', bare?.creator === null && bare?.artist === null && bare?.createdAt === null)
}

// ── 4. ranking ──────────────────────────────────────────────────────────────
console.log('rankSweepCandidates')
{
  const r = rankSweepCandidates([rk('a', 300n, ART_1, 1), rk('b', 100n, ART_2, 2), rk('c', 200n, ART_3, 3)])
  check('outlay ascending across tiers', r.map((i) => i.tokenId).join() === 'b,c,a')
}
{
  // One artist with five equal-priced pieces vs one other artist at that price.
  const tier = [
    rk('a50', 100n, ART_1, 50), rk('a40', 100n, ART_1, 40), rk('a20', 100n, ART_1, 20),
    rk('a10', 100n, ART_1, 10), rk('a5', 100n, ART_1, 5), rk('b30', 100n, ART_2, 30),
  ]
  const r = rankSweepCandidates(shuffle(tier))
  check('tier interleave: the other artist lands in slot 2, not slot 6', r[0].tokenId === 'a50' && r[1].tokenId === 'b30', r.map((i) => i.tokenId).join())
  check('tier interleave: newest-first within the artist afterwards', r.slice(2).map((i) => i.tokenId).join() === 'a40,a20,a10,a5')
  check('tier interleave: nothing lost', r.length === 6)
}
{
  const r = rankSweepCandidates([rk('a', 100n, ART_1, 50), rk('b', 100n, ART_2, 60)])
  check('artist order within a tier follows each artist\'s newest item', r.map((i) => i.tokenId).join() === 'b,a')
}
{
  const tier = [rk('n100', 100n, null, 100), rk('a95', 100n, ART_1, 95), rk('n90', 100n, null, 90), rk('a85', 100n, ART_1, 85)]
  const r = rankSweepCandidates(shuffle(tier))
  check('unattributed items are singleton groups (never merged into one "artist")', r.map((i) => i.tokenId).join() === 'n100,a95,n90,a85', r.map((i) => i.tokenId).join())
}
{
  const base = [rk('x', 100n, ART_1, null), rk('y', 100n, ART_1, 5), rk('z', 100n, ART_1, null)]
  const r = rankSweepCandidates(base)
  check('unknown dates sort after known ones, then by key', r.map((i) => i.tokenId).join() === 'y,x,z')
}
{
  const items = [rk('a', 100n, ART_1, 3), rk('b', 100n, ART_1, 2), rk('c', 100n, ART_1, 1), rk('d', 100n, ART_2, 2), rk('e', 100n, ART_2, 1), rk('f', 200n, ART_1, 9), rk('g', 50n, null, 1), rk('h', 50n, null, 2)]
  const capped = rankSweepCandidates(items, { perArtist: 1 })
  const perArtist = new Map<string, number>()
  for (const i of capped) if (i.artist) perArtist.set(i.artist, (perArtist.get(i.artist) ?? 0) + 1)
  check('perArtist=1: at most one item per artist', [...perArtist.values()].every((n) => n === 1), JSON.stringify([...perArtist]))
  check('perArtist: unattributed items are never capped', capped.filter((i) => i.artist === null).length === 2)
  check('perArtist keeps the cheapest of each artist (rank order preserved)', capped.map((i) => i.tokenId).join() === 'h,g,a,d')
  const all = rankSweepCandidates(items)
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    check(`invalid perArtist ${bad} is ignored (no cap)`, rankSweepCandidates(items, { perArtist: bad }).length === all.length)
  }
  const floored = rankSweepCandidates(items, { floorWei: 100n })
  check('floorWei drops everything below the floor', floored.every((i) => i.outlayWei >= 100n) && floored.length === all.length - 2)
  check('no options → nothing dropped', all.length === items.length)
}
{
  // Property sweep over random baskets.
  const artists = [ART_1, ART_2, ART_3, null]
  const items: RankableSweepItem[] = []
  for (let i = 0; i < 300; i++) {
    const tierIdx = Math.floor(rand() * 6)
    items.push(rk(`t${i}`, BigInt(100 + tierIdx * 10), artists[Math.floor(rand() * artists.length)], rand() < 0.1 ? null : Math.floor(rand() * 1_000_000)))
  }
  const r1 = rankSweepCandidates(items)
  const r2 = rankSweepCandidates(shuffle(items))
  let monotone = true
  for (let i = 1; i < r1.length; i++) if (r1[i].outlayWei < r1[i - 1].outlayWei) monotone = false
  check('property: outlay never decreases', monotone)
  check('property: every input appears exactly once', r1.length === items.length && new Set(keys(r1)).size === items.length)
  check('property: deterministic for any input order', keys(r1).join() === keys(r2).join())
  // Farming property: inside any tier holding ≥2 distinct artists, the first
  // two slots belong to two different artists.
  let farmingSafe = true
  for (let i = 0; i < r1.length; ) {
    let j = i + 1
    while (j < r1.length && r1[j].outlayWei === r1[i].outlayWei) j++
    const tier = r1.slice(i, j)
    const distinct = new Set(tier.map((t) => t.artist ?? sweepKey(t.address, t.tokenId)))
    if (distinct.size >= 2 && tier[0].artist !== null && tier[0].artist === tier[1].artist) farmingSafe = false
    i = j
  }
  check('property: no artist takes the first two slots of a shared tier', farmingSafe)
  const capped = rankSweepCandidates(items, { perArtist: 2 })
  const counts = new Map<string, number>()
  for (const i of capped) if (i.artist) counts.set(i.artist, (counts.get(i.artist) ?? 0) + 1)
  check('property: perArtist=2 never exceeded', [...counts.values()].every((n) => n <= 2))
}

// ── 5. pool cut + serve prefix ──────────────────────────────────────────────
console.log('finalizeSweepIndex / selectSweepItems / clampSweepN')
{
  const many: SweepIndexItem[] = []
  for (let i = 0; i < 130; i++) many.push(idx({ tokenId: String(i), outlayWei: String(1_000_000 - i * 10) })) // cheapest LAST on input
  const index = finalizeSweepIndex(many, 12345)
  check('eligible counts everything that ranked', index.eligible === 130)
  check(`pool is cut to SWEEP_POOL_SIZE (${SWEEP_POOL_SIZE})`, index.items.length === SWEEP_POOL_SIZE)
  check('pool holds the CHEAPEST, in order', index.items[0].tokenId === '129' && index.items[1].tokenId === '128')
  check('updatedAt passes through', index.updatedAt === 12345)
}
{
  const items: SweepIndexItem[] = []
  for (let i = 0; i < 70; i++) {
    items.push(idx({ tokenId: String(i), address: i % 7 === 0 ? COL_B : COL_A.toLowerCase(), creator: i % 5 === 0 ? ART_2 : ART_1, artist: i % 11 === 0 ? ART_3 : i % 5 === 0 ? ART_2 : ART_1 }))
  }
  const index = { updatedAt: 1, eligible: 70, items }
  const none = { hiddenMoments: new Set<string>(), hiddenCollections: new Set<string>(), hiddenUsers: new Set<string>() }
  const s10 = selectSweepItems(index, { n: 10, ...none })
  check('n=10 serves max(3n, 30) = 30 rows', s10.length === 30)
  check('serve order preserves rank order', s10.map((i) => i.tokenId).join() === items.slice(0, 30).map((i) => i.tokenId).join())
  const s20 = selectSweepItems(index, { n: 20, ...none })
  check('n=20 serves 60 rows', s20.length === 60)
  const hm = selectSweepItems(index, { n: 20, ...none, hiddenMoments: new Set([sweepKey(COL_A, '1'), sweepKey(COL_A.toUpperCase(), '2')]) })
  check('hidden moment keys are dropped (case-insensitive)', !hm.some((i) => i.tokenId === '1' || i.tokenId === '2') && hm.length === 60)
  const hc = selectSweepItems(index, { n: 20, ...none, hiddenCollections: new Set([COL_B]) })
  check('hidden collection drops all its rows', !hc.some((i) => i.address === COL_B))
  const hu = selectSweepItems(index, { n: 20, ...none, hiddenUsers: new Set([ART_2]) })
  check('admin-hidden CREATOR drops the row', !hu.some((i) => i.creator === ART_2))
  const ha = selectSweepItems(index, { n: 20, ...none, hiddenUsers: new Set([ART_3]) })
  check('admin-hidden folded ARTIST drops the row too', !ha.some((i) => i.artist === ART_3))
  check('serveCount floors at SWEEP_SERVE_MIN', serveCount(1) === SWEEP_SERVE_MIN && serveCount(10) === 30 && serveCount(11) === 33 && serveCount(20) === 60)
}
check('clampSweepN: absent → default', clampSweepN(null) === SWEEP_DEFAULT_N && clampSweepN('') === SWEEP_DEFAULT_N && clampSweepN(undefined) === SWEEP_DEFAULT_N)
check('clampSweepN: garbage → default', clampSweepN('x') === SWEEP_DEFAULT_N)
check('clampSweepN: floor 1', clampSweepN('0') === 1 && clampSweepN('-5') === 1)
check(`clampSweepN: ceiling ${SWEEP_MAX_N}`, clampSweepN('99') === SWEEP_MAX_N)
check('clampSweepN: in range passes', clampSweepN('15') === 15 && clampSweepN('7.9') === 7)

// ── 6. Moment projection + constants ────────────────────────────────────────
console.log('sweepItemToMoment / constants')
{
  const m = sweepItemToMoment(idx({ tokenId: '3', name: 'Dawn', image: 'ar://x', thumbhash: 'th' }))
  check('projection carries address / token_id / creator', m.address === COL_A.toLowerCase() && m.token_id === '3' && m.creator.address === ART_1 && m.creator.hidden === false)
  check('projection carries metadata under the feed keys', m.metadata?.name === 'Dawn' && m.metadata?.image === 'ar://x' && m.metadata?.kismet_thumbhash === 'th')
  const bare = sweepItemToMoment(idx({ tokenId: '4', creator: null, createdAt: null }))
  check('projection: unattributed → empty creator address, empty created_at', bare.creator.address === '' && bare.created_at === '')
}
check('SWEEP_MAX_N is the collect-all cap', SWEEP_MAX_N === MAX_COLLECT_ALL_BATCH && SWEEP_MAX_N === 20)
check('SWEEP_POOL_SIZE is 6 × the cap', SWEEP_POOL_SIZE === 6 * SWEEP_MAX_N)
check('sweepKey lowercases the collection', sweepKey(COL_A, '1') === `${COL_A.toLowerCase()}:1`)

console.log(failures === 0 ? '\nverify-sweep: ALL PASS' : `\nverify-sweep: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
