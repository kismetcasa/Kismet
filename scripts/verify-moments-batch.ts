// Verifies the pure resolution halves of two lib/saleConfig on-chain batch reads:
//   1. saleConfigsFromMulticall — /api/moments' batched price fallback.
//   2. soldOutKeysFromMulticall — the ending-soon feed's sold-out supply filter.
//
// WHAT IT GUARDS (1): the fallback prices a whole feed page's gaps in ONE
// multicall (even slot = ETH FixedPriceSaleStrategy, odd = USDC ERC20Minter,
// per token) instead of up-to-2N sequential eth_calls — the change that stops
// the price badge from taking 3-5s on a rate-limited RPC. These checks pin the
// slot indexing, ETH-over-USDC precedence, the USDC-currency gate, the
// saleEnd==0 "no sale" rule, and per-row failure isolation — the exact rules
// resolveOnchainSale enforces per-token, now applied across a batch.
//
// WHAT IT GUARDS (2): ending-soon must drop a CAPPED edition that minted out
// while its sale window is still open (nothing left to collect). These checks
// pin the exhaustion rule (totalMinted >= maxSupply), the open-edition exemption
// (0 and the max-uint64 sentinel), and the fail-OPEN bias on reverting/malformed
// rows — the exact rules MomentCard's `mintedOut` badge uses.
//
// Run: node --experimental-strip-types --import ./scripts/register-ts-alias.mjs scripts/verify-moments-batch.ts

import type { Address } from 'viem'
import {
  saleConfigsFromMulticall,
  soldOutKeysFromMulticall,
  type SaleReadSlot,
  type TokenInfoSlot,
} from '../lib/saleConfig.ts'
import { USDC_BASE, OPEN_EDITION_MINT_SIZE } from '../lib/zoraMint.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address
const C = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCcccc' as Address // mixed case → key must lowercase

function ok(result: unknown): SaleReadSlot {
  return { status: 'success', result }
}
function fail(): SaleReadSlot {
  return { status: 'failure', error: new Error('reverted') }
}
function ethSale(price: bigint, start: bigint, end: bigint) {
  return { saleStart: start, saleEnd: end, maxTokensPerAddress: BigInt(0), pricePerToken: price, fundsRecipient: A }
}
function usdcSale(price: bigint, start: bigint, end: bigint, currency: Address) {
  return { saleStart: start, saleEnd: end, maxTokensPerAddress: BigInt(0), pricePerToken: price, fundsRecipient: A, currency }
}

// ── 1. ETH sale on the even slot resolves to fixedPrice ──
{
  const items = [{ collection: A, tokenId: 1n }]
  const res: SaleReadSlot[] = [ok(ethSale(1000n, 5n, 999n)), fail()]
  const m = saleConfigsFromMulticall(res, items)
  const c = m.get(`${A}:1`)
  check('ETH sale → fixedPrice with real price + window',
    !!c && c.type === 'fixedPrice' && c.pricePerToken === '1000' && c.saleStart === '5' && c.saleEnd === '999' && !c.currency,
    JSON.stringify(c))
}

// ── 2. ETH takes precedence when BOTH strategies have a live row ──
{
  const items = [{ collection: A, tokenId: 2n }]
  const res: SaleReadSlot[] = [ok(ethSale(111n, 0n, 100n)), ok(usdcSale(222n, 0n, 100n, USDC_BASE as Address))]
  const c = saleConfigsFromMulticall(res, items).get(`${A}:2`)
  check('ETH precedence over USDC', !!c && c.type === 'fixedPrice' && c.pricePerToken === '111', JSON.stringify(c))
}

// ── 3. USDC resolves only when ETH slot is empty AND currency is USDC ──
{
  const items = [{ collection: A, tokenId: 3n }]
  const res: SaleReadSlot[] = [ok(ethSale(0n, 0n, 0n)), ok(usdcSale(500n, 1n, 888n, USDC_BASE as Address))]
  const c = saleConfigsFromMulticall(res, items).get(`${A}:3`)
  check('USDC sale → erc20Mint with currency tag',
    !!c && c.type === 'erc20Mint' && c.pricePerToken === '500' && c.currency === USDC_BASE, JSON.stringify(c))
}

// ── 4. Non-USDC ERC20 currency is rejected (no price) ──
{
  const items = [{ collection: A, tokenId: 4n }]
  const other = '0x1111111111111111111111111111111111111111' as Address
  const res: SaleReadSlot[] = [ok(ethSale(0n, 0n, 0n)), ok(usdcSale(500n, 1n, 888n, other))]
  check('non-USDC ERC20 sale → no price', saleConfigsFromMulticall(res, items).get(`${A}:4`) === undefined)
}

// ── 5. saleEnd==0 on both strategies → "no sale" → not in the map ──
{
  const items = [{ collection: A, tokenId: 5n }]
  const res: SaleReadSlot[] = [ok(ethSale(9n, 0n, 0n)), ok(usdcSale(9n, 0n, 0n, USDC_BASE as Address))]
  check('unset sale (saleEnd==0) → omitted', saleConfigsFromMulticall(res, items).get(`${A}:5`) === undefined)
}

// ── 6. A reverting/failed row is isolated — never sinks the batch ──
{
  const items = [{ collection: A, tokenId: 6n }]
  const res: SaleReadSlot[] = [fail(), fail()]
  check('both-strategy failure → omitted, no throw', saleConfigsFromMulticall(res, items).get(`${A}:6`) === undefined)
}

// ── 7. Scheduled-but-not-open drop (future saleStart) still carries the window ──
{
  const items = [{ collection: A, tokenId: 7n }]
  const res: SaleReadSlot[] = [ok(ethSale(42n, 9_000_000_000n, 9_999_999_999n)), fail()]
  const c = saleConfigsFromMulticall(res, items).get(`${A}:7`)
  check('scheduled drop keeps real saleStart (UI not-started gate)',
    !!c && c.saleStart === '9000000000' && c.saleEnd === '9999999999', JSON.stringify(c))
}

// ── 8. Multi-item batch: correct slot indexing + mixed-case key lowercasing ──
{
  const items = [
    { collection: A, tokenId: 1n },
    { collection: B, tokenId: 2n },
    { collection: C, tokenId: 3n },
  ]
  const res: SaleReadSlot[] = [
    ok(ethSale(100n, 0n, 10n)), fail(),                                   // A:1 → ETH
    ok(ethSale(0n, 0n, 0n)), ok(usdcSale(200n, 0n, 20n, USDC_BASE as Address)), // B:2 → USDC
    fail(), fail(),                                                       // C:3 → none
  ]
  const m = saleConfigsFromMulticall(res, items)
  check('batch slot 0 (A:1) → ETH 100', m.get(`${A.toLowerCase()}:1`)?.pricePerToken === '100')
  check('batch slot 1 (B:2) → USDC 200', m.get(`${B.toLowerCase()}:2`)?.type === 'erc20Mint' && m.get(`${B.toLowerCase()}:2`)?.pricePerToken === '200')
  check('batch slot 2 (C:3) → omitted', m.get(`${C.toLowerCase()}:3`) === undefined)
  check('key is lowercased (mixed-case collection C)', m.has(`${C.toLowerCase()}:3`) === false && [...m.keys()].every((k) => k === k.toLowerCase()))
}

// ── 9. Empty input → empty map ──
check('empty items → empty map', saleConfigsFromMulticall([], []).size === 0)

// ── soldOutKeysFromMulticall — ending-soon supply filter ─────────────────────
function info(maxSupply: bigint, totalMinted: bigint) {
  return { uri: 'ar://x', maxSupply, totalMinted }
}
function okInfo(result: unknown): TokenInfoSlot {
  return { status: 'success', result }
}
function failInfo(): TokenInfoSlot {
  return { status: 'failure', error: new Error('reverted') }
}

// ── S1. Capped edition, fully minted → sold out ──
{
  const items = [{ collection: A, tokenId: 1n }]
  const s = soldOutKeysFromMulticall([okInfo(info(100n, 100n))], items)
  check('capped edition totalMinted==maxSupply → sold out', s.has(`${A.toLowerCase()}:1`) && s.size === 1)
}

// ── S2. Capped edition with supply left → NOT sold out ──
{
  const items = [{ collection: A, tokenId: 2n }]
  const s = soldOutKeysFromMulticall([okInfo(info(100n, 99n))], items)
  check('capped edition totalMinted<maxSupply → not sold out', s.size === 0)
}

// ── S3. Over-minted (totalMinted > maxSupply) → sold out ──
{
  const items = [{ collection: A, tokenId: 3n }]
  const s = soldOutKeysFromMulticall([okInfo(info(50n, 51n))], items)
  check('over-minted → sold out', s.has(`${A.toLowerCase()}:3`))
}

// ── S4. Open edition (maxSupply 0) → never sold out ──
{
  const items = [{ collection: A, tokenId: 4n }]
  const s = soldOutKeysFromMulticall([okInfo(info(0n, 5_000n))], items)
  check('open edition (maxSupply 0) → not sold out', s.size === 0)
}

// ── S5. Open edition (max-uint64 sentinel) → never sold out ──
{
  const items = [{ collection: A, tokenId: 5n }]
  const s = soldOutKeysFromMulticall([okInfo(info(OPEN_EDITION_MINT_SIZE, OPEN_EDITION_MINT_SIZE))], items)
  check('open edition (uint64 sentinel) → not sold out', s.size === 0)
}

// ── S6. Reverting row → fail-open (not sold out) ──
{
  const items = [{ collection: A, tokenId: 6n }]
  check('reverting getTokenInfo → fail-open (not sold out)', soldOutKeysFromMulticall([failInfo()], items).size === 0)
}

// ── S7. Malformed result (missing fields) → fail-open ──
{
  const items = [{ collection: A, tokenId: 7n }]
  check('malformed result → fail-open (not sold out)', soldOutKeysFromMulticall([okInfo({ uri: 'ar://x' })], items).size === 0)
}

// ── S8. Multi-item batch: correct indexing + mixed-case key lowercasing ──
{
  const items = [
    { collection: A, tokenId: 1n }, // sold out
    { collection: B, tokenId: 2n }, // supply left
    { collection: C, tokenId: 3n }, // sold out, mixed-case collection
  ]
  const s = soldOutKeysFromMulticall(
    [okInfo(info(10n, 10n)), okInfo(info(10n, 1n)), okInfo(info(3n, 3n))],
    items,
  )
  check('batch: A:1 sold out', s.has(`${A.toLowerCase()}:1`))
  check('batch: B:2 not sold out', !s.has(`${B.toLowerCase()}:2`))
  check('batch: C:3 sold out with lowercased key', s.has(`${C.toLowerCase()}:3`) && [...s].every((k) => k === k.toLowerCase()))
  check('batch: exactly two sold out', s.size === 2)
}

// ── S9. Empty input → empty set ──
check('empty items → empty set', soldOutKeysFromMulticall([], []).size === 0)

if (failures > 0) {
  console.error(`\n${failures} moments-batch check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll moments-batch checks passed.')
