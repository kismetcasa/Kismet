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
//   - the pool cut, the serve prefix (3n floored at 30), the ?n= clamp, the
//     serve-time hide filters, and the Moment projection /api/sweep enriches;
//   - the client half (lib/sweepBatch.ts): every signed sub-call decodes to
//     1155.mint(FPSS, id, 1, [KISMET_REFERRAL], (mintTo, comment)) with value
//     = price + fee; the signed bundle is STRICT (allowFailure false on every
//     call); the simulated bundle is the same calls with allowFailure true;
//     the budget trim is a cheapest-first prefix; simulation results map by
//     position and fail closed on a length mismatch;
//   - on a fake chain behind a REAL viem client (scripts/_sweep-fake-chain.ts):
//     fetchEligibleTokensMulti's per-row rules and its single-eth_call claim,
//     readMintFeesWithBound's fail-closed map, simulateSweep's per-slot flags
//     and viem's real insufficient-funds mapping, estimateSweepGasCost, and
//     verifyBasket end to end (live values over index values, every drop
//     reason, the balance trim boundary, simulation drop + refill, the
//     simulation cap, insufficient-funds shedding, the gas refinement, RPC
//     failure at each step, the malformed-node case); the pool staleness rule.
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
import { MAX_COLLECT_ALL_BATCH, MULTICALL3_ADDRESS, OPEN_EDITION_MINT_SIZE } from '../lib/zoraMint.ts'
import {
  SWEEP_GAS_HEADROOM_WEI,
  applySimulation,
  buildSweepCalls,
  countSweepMints,
  sweepBundle,
  sweepSimulationArgs,
  trimToBudget,
  type SweepBasketItem,
} from '../lib/sweepBatch.ts'
import { DEFAULT_COLLECT_COMMENT } from '../lib/inprocess.ts'
import { SWEEP_INDEX_MAX_AGE_MS, isSweepIndexStale, type SweepResponseItem } from '../lib/sweepIndexCore.ts'
import { fetchEligibleTokensMulti, readMintFeesWithBound } from '../lib/saleConfig.ts'
import { estimateSweepGasCost, simulateSweep } from '../lib/sweepSimulate.ts'
import { MAX_SIMULATIONS, pendingRow, verifyBasket, type SweepRow } from '../lib/sweepVerify.ts'
import { createFakeChain, fakeClient, liveSale, mineTransaction, tokenKey } from './_sweep-fake-chain.ts'
import { FPSS, MINT_1155_ABI, REFERRAL } from './_agent-verify-helpers.ts'
import { decodeAbiParameters, decodeFunctionData, encodeFunctionData, getAddress, parseAbiParameters, parseEther } from 'viem'

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
  check('admitted: creator / artist / createdAt pass through', open?.creator === ART_1 && open?.artist === ART_1 && open?.createdAt === '2026-09-02T00:00:00Z')
  check('admitted: preview fields carried', open?.name === 'Dawn' && open?.image === 'ar://img' && open?.thumbhash === 'th')
  check('capped edition with room → admitted', buildSweepItem(cand('8', ART_2), sale(5n), { maxSupply: 10n, totalMinted: 7n }, FEE, NOW) !== null)
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

// ── 7. client half: the bundle the user signs, the one the client simulates ──
console.log('buildSweepCalls / sweepBundle / sweepSimulationArgs')
{
  const MINT_TO = getAddress('0x71Dc000000000000000000000000000000007244')
  const items: SweepBasketItem[] = [
    { address: COL_A as `0x${string}`, tokenId: 7n, priceWei: 1_000n, feeWei: FEE },
    { address: COL_B as `0x${string}`, tokenId: 12n, priceWei: 5_000_000_000_000_000n, feeWei: FEE },
  ]
  const calls = buildSweepCalls(items, MINT_TO)
  check('one sub-call per basket item, to each item\'s OWN collection', calls.length === 2 && calls[0].to === items[0].address && calls[1].to === items[1].address)
  check('each sub-call carries price + fee as its value', calls[0].value === 1_000n + FEE && calls[1].value === 5_000_000_000_000_000n + FEE)
  const decoded = calls.map((c) => decodeFunctionData({ abi: MINT_1155_ABI, data: c.data }))
  check('every call is 1155.mint', decoded.every((d) => d.functionName === 'mint'))
  const [d0, d1] = decoded
  check('minter is the inprocess FixedPriceSaleStrategy', getAddress(d0.args[0]) === getAddress(FPSS) && getAddress(d1.args[0]) === getAddress(FPSS))
  check('tokenId and quantity 1 per call', d0.args[1] === 7n && d1.args[1] === 12n && d0.args[2] === 1n && d1.args[2] === 1n)
  check('rewards recipient is KISMET_REFERRAL (treasury)', d0.args[3].length === 1 && getAddress(d0.args[3][0]) === getAddress(REFERRAL) && getAddress(d1.args[3][0]) === getAddress(REFERRAL))
  const [to0, comment0] = decodeAbiParameters(parseAbiParameters('address, string'), d0.args[4])
  check('minterArguments encode mintTo + the default collect comment', getAddress(to0) === MINT_TO && comment0 === DEFAULT_COLLECT_COMMENT)
  const custom = buildSweepCalls(items.slice(0, 1), MINT_TO, 'hello')
  const [, commentC] = decodeAbiParameters(parseAbiParameters('address, string'), decodeFunctionData({ abi: MINT_1155_ABI, data: custom[0].data }).args[4])
  check('a custom comment passes through', commentC === 'hello')

  const strict = sweepBundle(calls)
  check('signed bundle: aggregate3Value', strict.functionName === 'aggregate3Value')
  check('signed bundle: allowFailure is FALSE on every sub-call (never loosen — stranding hazard)', strict.args[0].every((c) => c.allowFailure === false))
  check('signed bundle: targets / calldata / values align with the calls', strict.args[0].every((c, i) => c.target === calls[i].to && c.callData === calls[i].data && c.value === calls[i].value))
  check('signed bundle: msg.value is the sum of the sub-call values', strict.value === 1_000n + FEE + 5_000_000_000_000_000n + FEE)

  const sim = sweepSimulationArgs(calls)
  check('simulation args: allowFailure is TRUE on every sub-call', sim.args[0].every((c) => c.allowFailure === true))
  check('simulation args: same targets / calldata / values as the signed bundle', sim.args[0].every((c, i) => c.target === strict.args[0][i].target && c.callData === strict.args[0][i].callData && c.value === strict.args[0][i].value))
  check('simulation args: same msg.value and function', sim.value === strict.value && sim.functionName === strict.functionName)
  check('empty basket → no calls, zero value', buildSweepCalls([], MINT_TO).length === 0 && sweepBundle([]).value === 0n)
}

console.log('trimToBudget / applySimulation / headroom')
{
  const w = (n: number) => ({ id: n, outlayWei: BigInt(n) })
  const items = [w(1), w(2), w(3), w(4)] // ascending, sum 10
  const exact = trimToBudget(items, 10n)
  check('exact fit keeps everything', exact.kept.length === 4 && exact.dropped.length === 0)
  const partial = trimToBudget(items, 6n)
  check('budget 6 keeps the prefix 1+2+3, drops the rest', partial.kept.map((i) => i.id).join() === '1,2,3' && partial.dropped.map((i) => i.id).join() === '4')
  check('budget below the first item keeps nothing', trimToBudget(items, 0n).kept.length === 0 && trimToBudget(items, 0n).dropped.length === 4)
  check('negative budget keeps nothing', trimToBudget(items, -1n).kept.length === 0)
  check('empty input → empty output', trimToBudget([], 5n).kept.length === 0 && trimToBudget([], 5n).dropped.length === 0)
  check('trim is a PREFIX (never skips a cheaper item to fit a later one)', trimToBudget([w(5), w(1)], 1n).kept.length === 0)

  const sim = applySimulation(['a', 'b', 'c'], [true, false, true])
  check('applySimulation maps by position', sim.kept.join() === 'a,c' && sim.dropped.join() === 'b')
  const mismatch = applySimulation(['a', 'b'], [true])
  check('applySimulation length mismatch drops everything (fail-closed)', mismatch.kept.length === 0 && mismatch.dropped.join() === 'a,b')
  check('applySimulation on empty input', applySimulation([], []).kept.length === 0)
  check('gas headroom is 0.0005 ETH', SWEEP_GAS_HEADROOM_WEI === parseEther('0.0005'))
}

// ── 8. fake chain: fetchEligibleTokensMulti ────────────────────────────────
// A real viem client (multicall batching on, like lib/wagmi.ts) over
// scripts/_sweep-fake-chain.ts. Every per-row rule of the sibling reader, the
// trailing balance slot, and the "one eth_call" claim, measured.
const USER = getAddress('0x71Dc000000000000000000000000000000007244')
const COL_A_HEX = COL_A.toLowerCase() as `0x${string}`
const COL_B_HEX = COL_B.toLowerCase() as `0x${string}`
const COL_C = '0xcccccccccccccccccccccccccccccccccccccccc' as `0x${string}`
const ETH = 10n ** 18n
const ended = (price: bigint) => ({ ...liveSale(price), saleEnd: NOW - 1n })
const scheduled = (price: bigint) => ({ ...liveSale(price), saleStart: NOW + 1n })

async function main() {
  console.log('fetchEligibleTokensMulti (fake chain)')
  {
    const chain = createFakeChain({ now: NOW, ethBalance: 3n * ETH })
    chain.fees.set(COL_A_HEX, FEE)
    chain.fees.set(COL_B_HEX, FEE)
    const put = (col: `0x${string}`, id: bigint, t: Parameters<typeof chain.tokens.set>[1]) => chain.tokens.set(tokenKey(col, id), t)
    put(COL_A_HEX, 1n, { sale: liveSale(1_000n) })
    put(COL_A_HEX, 2n, { sale: { saleStart: 0n, saleEnd: 0n, maxTokensPerAddress: 0n, pricePerToken: 0n } }) // unset
    put(COL_A_HEX, 3n, { sale: ended(1_000n) })
    put(COL_A_HEX, 4n, { sale: scheduled(1_000n) })
    put(COL_A_HEX, 5n, { sale: liveSale(1_000n), info: { maxSupply: 5n, totalMinted: 5n } }) // sold out
    put(COL_A_HEX, 6n, { sale: liveSale(2_000n), info: { maxSupply: 10n, totalMinted: 4n } }) // capped, room
    put(COL_A_HEX, 7n, { sale: liveSale(1_000n), balance: 1n }) // already owned
    put(COL_A_HEX, 8n, { sale: liveSale(1_000n, 2n), balance: 2n }) // per-address cap reached
    put(COL_A_HEX, 9n, { sale: 'garbage' })
    put(COL_A_HEX, 10n, { sale: 'revert' })
    put(COL_B_HEX, 1n, { sale: liveSale(3_000n), info: 'revert' }) // non-Zora getTokenInfo → unreadable → allowed
    put(COL_B_HEX, 2n, { sale: liveSale(1_000n), balance: 'revert' }) // balance read failed → dropped
    put(COL_B_HEX, 3n, { sale: liveSale(0n) }) // free: the reader returns it, the sweep drops it later
    const refs = [
      ...[1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n].map((tokenId) => ({ collection: COL_A_HEX, tokenId })),
      ...[1n, 2n, 3n].map((tokenId) => ({ collection: COL_B_HEX, tokenId })),
      { collection: COL_C, tokenId: 1n }, // never configured: sale() answers zeros → unset
    ]
    const client = fakeClient(chain)
    const res = await fetchEligibleTokensMulti(client, refs, USER, 1n)
    const keys = res.items.map((i) => tokenKey(i.collection, i.tokenId)).sort()
    check('exactly the live, unsold, unowned rows survive', keys.join() === [tokenKey(COL_A_HEX, 1n), tokenKey(COL_A_HEX, 6n), tokenKey(COL_B_HEX, 1n), tokenKey(COL_B_HEX, 3n)].sort().join(), keys.join())
    check('the trailing slot carries the wallet balance', res.ethBalance === 3n * ETH)
    check('ONE eth_call for 14 refs (viem never re-batches an aggregate3)', chain.ethCalls === 1, String(chain.ethCalls))
    const a1 = res.items.find((i) => i.tokenId === 1n && i.collection === COL_A_HEX)!
    const a6 = res.items.find((i) => i.tokenId === 6n)!
    check('live price and per-address cap are the strategy\'s', a1.pricePerToken === 1_000n && a1.maxPerAddress === 0n && a1.ownedBalance === 0n)
    check('remaining supply is carried for capped rows only', a6.remainingSupply === 6n && a1.remainingSupply === undefined)
    check('a free live row is returned with price 0 (the sweep decides)', res.items.some((i) => i.tokenId === 3n && i.collection === COL_B_HEX && i.pricePerToken === 0n))
    const none = await fetchEligibleTokensMulti(client, [], USER)
    check('empty refs → no items, null balance, no RPC', none.items.length === 0 && none.ethBalance === null && chain.ethCalls === 1)
    chain.failing = true
    const down = await fetchEligibleTokensMulti(client, refs, USER)
    check('RPC failure → no items AND null balance (distinguishable from empty)', down.items.length === 0 && down.ethBalance === null)
    chain.failing = false
    const owned2 = await fetchEligibleTokensMulti(client, [{ collection: COL_A_HEX, tokenId: 7n }], USER, 2n)
    check('excludeOwnedAtOrAbove is a threshold (owning 1 of 2 is allowed)', owned2.items.length === 1)
  }

  // ── 9. fake chain: readMintFeesWithBound ────────────────────────────────
  console.log('readMintFeesWithBound (fake chain)')
  {
    const chain = createFakeChain()
    const COL_D = '0xdddddddddddddddddddddddddddddddddddddddd' as `0x${string}`
    const COL_E = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as `0x${string}`
    chain.fees.set(COL_A_HEX, FEE)
    chain.fees.set(COL_B_HEX, parseEther('0.02')) // over the 0.01 ETH bound
    chain.fees.set(COL_C, 'revert')
    chain.fees.set(COL_D, 'garbage')
    // COL_E: absent — no such contract
    const client = fakeClient(chain)
    const fees = await readMintFeesWithBound(client, [COL_A as `0x${string}`, COL_A_HEX, COL_B_HEX, COL_C, COL_D, COL_E])
    check('in-bound fee is returned under the lowercased address', fees.get(COL_A_HEX) === FEE && fees.size === 1)
    check('over-bound / reverting / garbage / absent collections are ABSENT (fail-closed)', !fees.has(COL_B_HEX) && !fees.has(COL_C) && !fees.has(COL_D) && !fees.has(COL_E))
    check('mixed-case duplicates collapse into one read', chain.ethCalls === 1)
    await readMintFeesWithBound(client, [])
    check('empty input makes no RPC call', chain.ethCalls === 1)
    chain.failing = true
    let threw = false
    try {
      await readMintFeesWithBound(client, [COL_A_HEX])
    } catch {
      threw = true
    }
    check('an RPC-level failure THROWS (never an empty map that would drop every collection)', threw)
  }

  // ── 10. fake chain: simulateSweep / estimateSweepGasCost ─────────────────
  console.log('simulateSweep / estimateSweepGasCost (fake chain)')
  {
    const chain = createFakeChain()
    chain.fees.set(COL_A_HEX, FEE)
    chain.tokens.set(tokenKey(COL_A_HEX, 1n), { sale: liveSale(1_000n) })
    chain.tokens.set(tokenKey(COL_A_HEX, 6n), { sale: liveSale(2_000n) })
    const items: SweepBasketItem[] = [
      { address: COL_A_HEX, tokenId: 1n, priceWei: 1_000n, feeWei: FEE },
      { address: COL_A_HEX, tokenId: 6n, priceWei: 2_000n, feeWei: FEE },
    ]
    const client = fakeClient(chain)
    const calls = buildSweepCalls(items, USER)
    const sim1 = await simulateSweep(client, USER, calls)
    check('every sub-call succeeds → per-slot true', 'ok' in sim1 && sim1.ok.join() === 'true,true', JSON.stringify(sim1))
    chain.tokens.get(tokenKey(COL_A_HEX, 6n))!.mintOk = false
    const sim2 = await simulateSweep(client, USER, calls)
    check('a would-revert sub-call reports false in ITS slot only', 'ok' in sim2 && sim2.ok.join() === 'true,false')
    chain.tokens.get(tokenKey(COL_A_HEX, 6n))!.mintOk = true
    const tampered = calls.map((c, i) => (i === 0 ? { ...c, value: c.value + 1n } : c))
    const sim3 = await simulateSweep(client, USER, tampered)
    check('a value that is not price + fee fails that slot (FPSS strict equality)', 'ok' in sim3 && sim3.ok.join() === 'false,true')
    chain.nodeBalance = 0n
    const sim4 = await simulateSweep(client, USER, calls)
    check("the node's insufficient-funds refusal is classified through viem's real error chain", 'error' in sim4 && sim4.error === 'insufficient-funds', JSON.stringify(sim4))
    chain.nodeBalance = null
    chain.failing = true
    const sim5 = await simulateSweep(client, USER, calls)
    check('any other RPC failure is "rpc"', 'error' in sim5 && sim5.error === 'rpc')
    chain.failing = false
    const before = chain.ethCalls
    const sim6 = await simulateSweep(client, USER, [])
    check('an empty basket simulates nothing', 'ok' in sim6 && sim6.ok.length === 0 && chain.ethCalls === before)
    check('five simulations attempted; the refused and the failed ones never ran', chain.simAttempts === 5 && chain.simulations === 3, `${chain.simAttempts}/${chain.simulations}`)
    check('no simulation ever carried allowFailure=false (the node never sees a strict bundle)', chain.strictSimulations === 0)

    const fees = await client.estimateFeesPerGas()
    const cost = await estimateSweepGasCost(client, USER, calls)
    check('gas cost = estimateGas × maxFeePerGas (EIP-1559 cap, not the base fee)', cost === 3_000_000n * fees.maxFeePerGas && cost !== null && cost > 0n, String(cost))
    chain.gas = 'error'
    check('an unavailable estimate is null (the caller keeps the headroom)', (await estimateSweepGasCost(client, USER, calls)) === null)
    chain.gas = 3_000_000n
    check('an empty basket costs 0', (await estimateSweepGasCost(client, USER, [])) === 0n)
  }

  // ── 11. fake chain: verifyBasket end to end ──────────────────────────────
  console.log('verifyBasket (fake chain)')
  const poolItem = (col: `0x${string}`, id: number, artist: string | null = ART_1): SweepResponseItem => ({
    address: col,
    tokenId: String(id),
    // Index numbers are deliberately WRONG: the verification must never use them.
    priceWei: '1',
    feeWei: '1',
    outlayWei: '2',
    creator: artist,
    artist,
    createdAt: new Date(1_700_000_000_000 + id * 1000).toISOString(),
    creatorProfile: { username: null },
  })
  const rowsOf = (rows: SweepRow[], state: SweepRow['state']) => rows.filter((r) => r.state === state)
  const ids = (rows: SweepRow[]) => rows.map((r) => r.item.tokenId).join()
  const HEADROOM = parseEther('0.0005')

  /** n live tokens on COL_A priced 100·id wei, fee FEE, each by its own artist. */
  function stage(count: number, over: Partial<ReturnType<typeof createFakeChain>> = {}) {
    const chain = createFakeChain({ now: NOW, ...over })
    chain.fees.set(COL_A_HEX, FEE)
    const pending: SweepRow[] = []
    for (let id = 1; id <= count; id++) {
      chain.tokens.set(tokenKey(COL_A_HEX, BigInt(id)), { sale: liveSale(100n * BigInt(id)) })
      pending.push(pendingRow(poolItem(COL_A_HEX, id, `0x${String(id).padStart(40, '0')}`)))
    }
    return { chain, pending, client: fakeClient(chain) }
  }
  const outlay = (id: number) => 100n * BigInt(id) + FEE

  {
    // S1 — happy path
    const { chain, pending, client } = stage(12)
    const v = await verifyBasket(client, USER, pending, 10)
    check('S1 ok', v.ok)
    if (v.ok) {
      const basket = rowsOf(v.rows, 'basket')
      check('S1 basket = the 10 cheapest by LIVE outlay, ascending', ids(basket) === '1,2,3,4,5,6,7,8,9,10', ids(basket))
      check('S1 live price and fee replace the index numbers', basket.every((r) => r.priceWei === 100n * BigInt(r.item.tokenId) && r.feeWei === FEE && r.outlayWei === r.priceWei + r.feeWei))
      check('S1 the two beyond n are reserve', ids(rowsOf(v.rows, 'reserve')) === '11,12')
      check('S1 gas estimate recorded', typeof v.gasCostWei === 'bigint' && v.gasCostWei > 0n)
      check('S1 chain traffic: 3 eth_calls (multi read, fees, ONE simulation) + 1 estimate', chain.ethCalls === 3 && chain.simulations === 1 && chain.log.filter((l) => l.method === 'eth_estimateGas').length === 1, `${chain.ethCalls}/${chain.simulations}`)
    }
  }
  {
    // S2 — every drop reason
    const { chain, pending, client } = stage(4)
    chain.tokens.set(tokenKey(COL_A_HEX, 2n), { sale: ended(200n) })
    chain.tokens.set(tokenKey(COL_A_HEX, 3n), { sale: liveSale(300n), balance: 1n })
    chain.tokens.set(tokenKey(COL_A_HEX, 4n), { sale: liveSale(0n) })
    chain.fees.set(COL_B_HEX, parseEther('0.5')) // over bound → unreadable
    chain.tokens.set(tokenKey(COL_B_HEX, 1n), { sale: liveSale(50n) })
    pending.push(pendingRow(poolItem(COL_B_HEX, 1)))
    const v = await verifyBasket(client, USER, pending, 10)
    check('S2 ok', v.ok)
    if (v.ok) {
      const reason = (id: string, col = COL_A_HEX) => v.rows.find((r) => r.item.tokenId === id && r.item.address === col)?.reason
      check('S2 ended → "sold out, ended, or already yours"', reason('2') === 'sold out, ended, or already yours')
      check('S2 owned → the same reason', reason('3') === 'sold out, ended, or already yours')
      check('S2 price 0 → "now a free mint"', reason('4') === 'now a free mint')
      check('S2 fee over bound → "mint fee unreadable"', reason('1', COL_B_HEX) === 'mint fee unreadable')
      check('S2 the one live row is the basket', ids(rowsOf(v.rows, 'basket')) === '1')
    }
  }
  {
    // S3 — the balance trim boundary
    const three = outlay(1) + outlay(2) + outlay(3)
    const exact = stage(5, { ethBalance: HEADROOM + three })
    const v1 = await verifyBasket(exact.client, USER, exact.pending, 5)
    check('S3 balance = headroom + 3 cheapest → exactly 3 in the basket', v1.ok && ids(rowsOf(v1.rows, 'basket')) === '1,2,3')
    check('S3 the rest are unaffordable with the reason', v1.ok && rowsOf(v1.rows, 'unaffordable').every((r) => r.reason === 'needs more ETH') && ids(rowsOf(v1.rows, 'unaffordable')) === '4,5')
    const less = stage(5, { ethBalance: HEADROOM + three - 1n })
    const v2 = await verifyBasket(less.client, USER, less.pending, 5)
    check('S3 one wei less → 2', v2.ok && ids(rowsOf(v2.rows, 'basket')) === '1,2')
    const broke = stage(3, { ethBalance: 0n })
    const v3 = await verifyBasket(broke.client, USER, broke.pending, 3)
    check('S3 zero balance → empty basket, all unaffordable, nothing simulated', v3.ok && rowsOf(v3.rows, 'basket').length === 0 && rowsOf(v3.rows, 'unaffordable').length === 3 && broke.chain.simulations === 0)
  }
  {
    // S4 — a simulation drop refills from the reserve and re-simulates
    const { chain, pending, client } = stage(5)
    chain.tokens.get(tokenKey(COL_A_HEX, 2n))!.mintOk = false
    const v = await verifyBasket(client, USER, pending, 3)
    check('S4 basket = 1,3 + the refilled 4', v.ok && ids(rowsOf(v.rows, 'basket')) === '1,3,4', v.ok ? ids(rowsOf(v.rows, 'basket')) : 'rpc')
    check('S4 the failed row is dropped as "not mintable right now"', v.ok && rowsOf(v.rows, 'dropped').length === 1 && rowsOf(v.rows, 'dropped')[0].reason === 'not mintable right now')
    check('S4 exactly two simulations', chain.simulations === 2)
    check('S4 the untouched reserve row stays reserve', v.ok && ids(rowsOf(v.rows, 'reserve')) === '5')
  }
  {
    // S5 — the simulation cap: a new failure every round
    const { chain, pending, client } = stage(6)
    chain.simPolicy = (sim, key) => !(key.endsWith(`:${2 + sim}`)) // round 1 fails #3, round 2 fails #4, round 3 fails #5
    const v = await verifyBasket(client, USER, pending, 3)
    check('S5 at most MAX_SIMULATIONS rounds', chain.simulations === MAX_SIMULATIONS)
    check('S5 after the last round only rows that PASSED it remain', v.ok && ids(rowsOf(v.rows, 'basket')) === '1,2', v.ok ? ids(rowsOf(v.rows, 'basket')) : 'rpc')
    check('S5 every failed row is dropped, the never-simulated one stays reserve', v.ok && ids(rowsOf(v.rows, 'dropped')) === '3,4,5' && ids(rowsOf(v.rows, 'reserve')) === '6')
  }
  {
    // S6 — the node refuses the value (balance moved between the read and the simulation)
    const mild = stage(3)
    mild.chain.nodeBalance = outlay(1) + outlay(2) // covers two, not three
    const v1 = await verifyBasket(mild.client, USER, mild.pending, 3)
    check('S6 insufficient funds sheds the priciest and re-simulates', v1.ok && ids(rowsOf(v1.rows, 'basket')) === '1,2' && ids(rowsOf(v1.rows, 'unaffordable')) === '3', v1.ok ? ids(rowsOf(v1.rows, 'basket')) : 'rpc')
    check('S6 two attempts: the refused one, then the one that ran', mild.chain.simAttempts === 2 && mild.chain.simulations === 1, `${mild.chain.simAttempts}/${mild.chain.simulations}`)
    const hard = stage(4)
    hard.chain.nodeBalance = 0n
    const v2 = await verifyBasket(hard.client, USER, hard.pending, 4)
    check('S6 persistent refusal → nothing reaches the wallet unverified', v2.ok && rowsOf(v2.rows, 'basket').length === 0 && rowsOf(v2.rows, 'unaffordable').length === 4)
    check('S6 bounded by MAX_SIMULATIONS attempts', hard.chain.simAttempts === MAX_SIMULATIONS && hard.chain.simulations === 0)
  }
  {
    // S7 — the gas refinement
    const three = outlay(1) + outlay(2) + outlay(3)
    const spike = stage(3, { ethBalance: HEADROOM + three, gas: 100_000_000n }) // ≈ 0.0012 ETH at 0.01 gwei × 1.2
    const v1 = await verifyBasket(spike.client, USER, spike.pending, 3)
    const fees = await spike.client.estimateFeesPerGas()
    const gasCost = 100_000_000n * fees.maxFeePerGas
    check('S7 a real estimate above the headroom sheds rows until outlay + gas fits', v1.ok && v1.gasCostWei === gasCost && rowsOf(v1.rows, 'basket').length < 3 && (rowsOf(v1.rows, 'basket').length === 0 || spike.chain.ethBalance >= rowsOf(v1.rows, 'basket').reduce((s, r) => s + r.outlayWei, 0n) + gasCost))
    const noEst = stage(3, { ethBalance: HEADROOM + three, gas: 'error' })
    const v2 = await verifyBasket(noEst.client, USER, noEst.pending, 3)
    check('S7 a strict bundle that cannot be estimated is never presented as ready ("could not verify")', !v2.ok)
  }
  {
    // S8 — an RPC failure at each step is "could not verify", never an empty basket
    const a = stage(3, { failing: true })
    check('S8 aggregate read fails → rpc', !(await verifyBasket(a.client, USER, a.pending, 3)).ok)
    const b = stage(3)
    b.chain.failCalls.add(1) // the fee read
    check('S8 fee read fails → rpc', !(await verifyBasket(b.client, USER, b.pending, 3)).ok)
    const c = stage(3)
    c.chain.failCalls.add(2) // the simulation
    check('S8 simulation RPC failure → rpc', !(await verifyBasket(c.client, USER, c.pending, 3)).ok)
    const d = stage(0)
    const v = await verifyBasket(d.client, USER, d.pending, 3)
    check('S8 nothing pending → ok with no rows and no RPC', v.ok && v.rows.length === 0 && d.chain.ethCalls === 0)
  }
  {
    // S9 — a malformed node answer (one Result short) can never seat a row
    const { chain, pending, client } = stage(3)
    chain.simTruncate = true
    const v = await verifyBasket(client, USER, pending, 3)
    check('S9 length mismatch → no basket row, everything dropped or reserve', v.ok && rowsOf(v.rows, 'basket').length === 0)
  }
  {
    // S10 — a refill that does not fit the remaining budget is not taken
    const two = outlay(1) + outlay(2)
    const { chain, pending, client } = stage(3, { ethBalance: HEADROOM + two })
    chain.tokens.get(tokenKey(COL_A_HEX, 2n))!.mintOk = false
    const v = await verifyBasket(client, USER, pending, 2)
    check('S10 the reserve row costs more than the room → basket stays [1]', v.ok && ids(rowsOf(v.rows, 'basket')) === '1' && ids(rowsOf(v.rows, 'reserve')) === '3')
  }
  {
    // S11 — artist interleave on LIVE ties (the index's rule, applied at click time)
    const chain = createFakeChain({ now: NOW })
    chain.fees.set(COL_A_HEX, FEE)
    const pending: SweepRow[] = []
    const artistX = `0x${'ab'.repeat(20)}`
    const artistY = `0x${'cd'.repeat(20)}`
    for (const [id, artist] of [[1, artistX], [2, artistX], [3, artistX], [4, artistY]] as const) {
      chain.tokens.set(tokenKey(COL_A_HEX, BigInt(id)), { sale: liveSale(100n) }) // one price tier
      pending.push(pendingRow(poolItem(COL_A_HEX, id, artist)))
    }
    const v = await verifyBasket(fakeClient(chain), USER, pending, 2)
    // The ranker orders artists by their newest item (Y's #4 is newest), then
    // interleaves — so the two slots go to two DIFFERENT artists, never X twice.
    const basket = v.ok ? rowsOf(v.rows, 'basket') : []
    check('S11 within one price tier a two-slot basket takes one row from each artist', v.ok && basket.length === 2 && new Set(basket.map((r) => r.item.artist)).size === 2, ids(basket))
  }

  // ── 11b. countSweepMints: success is the receipt showing the mints ────────
  console.log('countSweepMints (fake chain receipts)')
  {
    const chain = createFakeChain({ now: NOW, ethBalance: ETH })
    chain.fees.set(COL_A_HEX, FEE)
    chain.fees.set(COL_B_HEX, FEE)
    chain.tokens.set(tokenKey(COL_A_HEX, 1n), { sale: liveSale(1_000n) })
    chain.tokens.set(tokenKey(COL_B_HEX, 2n), { sale: liveSale(2_000n) })
    const items: SweepBasketItem[] = [
      { address: COL_A_HEX, tokenId: 1n, priceWei: 1_000n, feeWei: FEE },
      { address: COL_B_HEX, tokenId: 2n, priceWei: 2_000n, feeWei: FEE },
    ]
    const calls = buildSweepCalls(items, USER)
    const bundle = sweepBundle(calls)
    const data = encodeFunctionData({ abi: bundle.abi, functionName: bundle.functionName, args: bundle.args })
    const hash = mineTransaction(chain, { from: USER, to: MULTICALL3_ADDRESS, value: bundle.value, data })
    const logs = chain.receipts.get(hash)!.logs as Parameters<typeof countSweepMints>[0]
    check('a mined bundle counts one mint per basket item', countSweepMints(logs, items, USER) === 2)
    check('logs to another recipient do not count', countSweepMints(logs, items, getAddress('0x00000000000000000000000000000000000000AA')) === 0)
    check('a basket the receipt does not cover counts 0', countSweepMints(logs, [{ address: COL_A_HEX, tokenId: 9n, priceWei: 1n, feeWei: FEE }], USER) === 0)
    check('the same log never counts twice', countSweepMints([...logs, ...logs], items, USER) === 2)
    chain.replaceNextWithCancel = true
    const cancelled = mineTransaction(chain, { from: USER, to: MULTICALL3_ADDRESS, value: bundle.value, data })
    const r = chain.receipts.get(cancelled)!
    check('a wallet-side cancel mines as success with no mints under another hash', r.status === '0x1' && countSweepMints(r.logs as Parameters<typeof countSweepMints>[0], items, USER) === 0 && r.transactionHash !== cancelled)
  }

  // ── 12. pool staleness ──────────────────────────────────────────────────
  console.log('isSweepIndexStale')
  const T = 1_800_000_000_000
  check('fresh at build time', !isSweepIndexStale({ updatedAt: T }, T))
  check('fresh one ms inside the cutoff', !isSweepIndexStale({ updatedAt: T - SWEEP_INDEX_MAX_AGE_MS + 1 }, T))
  check('stale one ms past the cutoff', isSweepIndexStale({ updatedAt: T - SWEEP_INDEX_MAX_AGE_MS - 1 }, T))
  check('a slightly future timestamp (clock skew) is fresh', !isSweepIndexStale({ updatedAt: T + 60_000 }, T))
  check('a non-finite timestamp is stale', isSweepIndexStale({ updatedAt: Number.NaN }, T))
  check('the cutoff is a day (the ops threshold pages at 3 h)', SWEEP_INDEX_MAX_AGE_MS === 24 * 60 * 60 * 1000)

  console.log(failures === 0 ? '\nverify-sweep: ALL PASS' : `\nverify-sweep: ${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('verify-sweep crashed:', e)
  process.exit(1)
})
