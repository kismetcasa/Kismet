// Verifies the pure resolution half of /api/moments' batched on-chain price
// fallback (lib/saleConfig.saleConfigsFromMulticall).
//
// WHAT IT GUARDS: the fallback now prices a whole feed page's gaps in ONE
// multicall (even slot = ETH FixedPriceSaleStrategy, odd = USDC ERC20Minter,
// per token) instead of up-to-2N sequential eth_calls — the change that stops
// the price badge from taking 3-5s on a rate-limited RPC. These checks pin the
// slot indexing, ETH-over-USDC precedence, the USDC-currency gate, the
// saleEnd==0 "no sale" rule, and per-row failure isolation — the exact rules
// resolveOnchainSale enforces per-token, now applied across a batch.
//
// Run: node --experimental-strip-types --import ./scripts/register-ts-alias.mjs scripts/verify-moments-batch.ts

import type { Address } from 'viem'
import { saleConfigsFromMulticall, type SaleReadSlot } from '../lib/saleConfig.ts'
import { USDC_BASE } from '../lib/zoraMint.ts'

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

if (failures > 0) {
  console.error(`\n${failures} moments-batch check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll moments-batch checks passed.')
