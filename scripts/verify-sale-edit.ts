// Verifies the sale-window editor's pure core (lib/saleEdit) in CI so a
// regression goes red on the PR instead of silently mis-writing on-chain sale
// rows. The mistakes this pins are money bugs, not display bugs:
//   1. fullSaleFromMulticall picks the SAME sale the display/collect paths
//      resolve (ETH precedence, saleEnd!==0 = row exists, USDC-only ERC20),
//      so the editor can never rewrite a different strategy's row.
//   2. resolveEditedWindow's tri-state field semantics: untouched = keep the
//      on-chain value EXACTLY, cleared = open-now / never-expires, picked
//      past-start normalizes to 0, picked end must be future and after the
//      start, and an unchanged window reports changed:false (no wallet
//      prompt for a no-op).
//   3. resolveEndNow closes at now and zeroes a still-scheduled start.
//   4. buildSaleUpdateCall carries price / per-address cap / fundsRecipient /
//      currency through UNCHANGED (fundsRecipient is the 0xSplits wallet on
//      split artworks — clobbering it redirects revenue) and encodes each
//      strategy's exact tuple layout. Decoded back through an INDEPENDENT
//      human-readable ABI spelling so a field-order drift can't self-verify.
//   5. The open-ended sentinel round-trips bit-exact through encode/decode
//      (the reason the edit path is a direct wallet write and not inprocess's
//      number-typed POST /moment/sale) and saleToDisplayConfig hands the
//      display layer a saleEnd its shared classifier reads as open-ended.
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//        --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        scripts/verify-sale-edit.ts

import { decodeFunctionData, parseAbi, type Address } from 'viem'
import {
  buildSaleUpdateCall,
  fullSaleFromMulticall,
  resolveEditedWindow,
  resolveEndNow,
  saleToDisplayConfig,
  type FullOnchainSale,
} from '../lib/saleEdit.ts'
import { OPEN_ENDED_SALE_SENTINEL, parseRealSaleEnd } from '../lib/inprocess.ts'
import { USDC_BASE, ZORA_ERC20_MINTER, ZORA_FIXED_PRICE_STRATEGY } from '../lib/zoraMint.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

const SPLITS_WALLET = '0x1111111111111111111111111111111111111111' as Address
const nowSec = 1_800_000_000 // fixed clock — the core takes nowSec explicitly

// ── 1. fullSaleFromMulticall — strategy discrimination ──────────────────────
const ethRow = {
  saleStart: 0n,
  saleEnd: 1_900_000_000n,
  maxTokensPerAddress: 3n,
  pricePerToken: 44_000_000_000_000_000n,
  fundsRecipient: SPLITS_WALLET,
}
const usdcRow = { ...ethRow, pricePerToken: 5_000_000n, currency: USDC_BASE as Address }
const ok = (result: unknown) => ({ status: 'success' as const, result })
const fail = { status: 'failure' as const }

const ethSale = fullSaleFromMulticall([ok(ethRow), ok(usdcRow)])
check('ETH row present -> fixedPrice wins', ethSale?.type === 'fixedPrice')
check('ETH sale targets FPSS', ethSale?.strategy === ZORA_FIXED_PRICE_STRATEGY)
check('ETH sale carries fundsRecipient', ethSale?.fundsRecipient === SPLITS_WALLET)

const usdcSale = fullSaleFromMulticall([ok({ ...ethRow, saleEnd: 0n }), ok(usdcRow)])
check('ETH row unset -> erc20Mint resolves', usdcSale?.type === 'erc20Mint')
check('USDC sale targets ERC20Minter', usdcSale?.strategy === ZORA_ERC20_MINTER)
check('USDC sale carries currency', usdcSale?.currency === USDC_BASE)
check(
  'non-USDC ERC20 -> null (no editable sale)',
  fullSaleFromMulticall([
    ok({ ...ethRow, saleEnd: 0n }),
    ok({ ...usdcRow, currency: SPLITS_WALLET }),
  ]) === null,
)
check(
  'both rows unset -> null',
  fullSaleFromMulticall([ok({ ...ethRow, saleEnd: 0n }), ok({ ...usdcRow, saleEnd: 0n })]) === null,
)
check('both reads failed -> null', fullSaleFromMulticall([fail, fail]) === null)
check(
  'ETH read failed, USDC live -> erc20Mint still resolves',
  fullSaleFromMulticall([fail, ok(usdcRow)])?.type === 'erc20Mint',
)

// ── 2. resolveEditedWindow — the edit-form semantics ────────────────────────
const openSale = { saleStart: 1_700_000_000n, saleEnd: 1_900_000_000n } // started, real end
const scheduledSale = { saleStart: BigInt(nowSec + 7_200), saleEnd: OPEN_ENDED_SALE_SENTINEL }

let r = resolveEditedWindow(openSale, { start: { kind: 'keep' }, end: { kind: 'keep' } }, nowSec)
check('keep/keep -> ok, unchanged', r.ok && !r.changed)
check(
  'keep/keep -> carries exact on-chain values',
  r.ok && r.saleStart === openSale.saleStart && r.saleEnd === openSale.saleEnd,
)

r = resolveEditedWindow(openSale, { start: { kind: 'clear' }, end: { kind: 'keep' } }, nowSec)
check(
  'clear start on OPEN sale -> keeps current start (no history rewrite)',
  r.ok && r.saleStart === openSale.saleStart && !r.changed,
)

r = resolveEditedWindow(scheduledSale, { start: { kind: 'clear' }, end: { kind: 'keep' } }, nowSec)
check('clear start on SCHEDULED sale -> opens now (0)', r.ok && r.saleStart === 0n && r.changed)

r = resolveEditedWindow(openSale, { start: { kind: 'set', sec: nowSec - 60 }, end: { kind: 'keep' } }, nowSec)
check('picked past start -> normalizes to 0', r.ok && r.saleStart === 0n)

r = resolveEditedWindow(openSale, { start: { kind: 'set', sec: nowSec + 3_600 }, end: { kind: 'keep' } }, nowSec)
check('picked future start -> scheduled at that instant', r.ok && r.saleStart === BigInt(nowSec + 3_600))

r = resolveEditedWindow(openSale, { start: { kind: 'keep' }, end: { kind: 'clear' } }, nowSec)
check('clear end -> exact open-ended sentinel', r.ok && r.saleEnd === OPEN_ENDED_SALE_SENTINEL)

r = resolveEditedWindow(scheduledSale, { start: { kind: 'keep' }, end: { kind: 'clear' } }, nowSec)
check('clear end on already-open-ended -> unchanged (no wallet prompt)', r.ok && !r.changed)

r = resolveEditedWindow(openSale, { start: { kind: 'keep' }, end: { kind: 'set', sec: nowSec - 1 } }, nowSec)
check('picked past end -> rejected (end-now is its own path)', !r.ok)

r = resolveEditedWindow(
  openSale,
  { start: { kind: 'set', sec: nowSec + 7_200 }, end: { kind: 'set', sec: nowSec + 3_600 } },
  nowSec,
)
check('end before start -> rejected', !r.ok)

r = resolveEditedWindow(
  openSale,
  { start: { kind: 'set', sec: nowSec + 3_600 }, end: { kind: 'set', sec: nowSec + 7_200 } },
  nowSec,
)
check(
  'scheduled window -> both edges land',
  r.ok && r.saleStart === BigInt(nowSec + 3_600) && r.saleEnd === BigInt(nowSec + 7_200) && r.changed,
)

r = resolveEditedWindow(openSale, { start: { kind: 'set', sec: 1.5 }, end: { kind: 'keep' } }, nowSec)
check('non-integer start -> rejected', !r.ok)

// ── 3. resolveEndNow ────────────────────────────────────────────────────────
let closed = resolveEndNow(openSale, nowSec)
check(
  'end now on open sale -> end=now, start untouched',
  closed.saleEnd === BigInt(nowSec) && closed.saleStart === openSale.saleStart,
)
closed = resolveEndNow(scheduledSale, nowSec)
check(
  'end now on scheduled sale -> start zeroed (no ended-before-it-opened row)',
  closed.saleEnd === BigInt(nowSec) && closed.saleStart === 0n,
)

// ── 4. buildSaleUpdateCall — field preservation + tuple layout ──────────────
// Decode with an INDEPENDENT human-readable ABI spelling (not the encode
// ABI), so a component-order mistake in lib/saleEdit cannot verify itself.
const FPSS_HUMAN = parseAbi([
  'function setSale(uint256 tokenId, (uint64 saleStart, uint64 saleEnd, uint64 maxTokensPerAddress, uint96 pricePerToken, address fundsRecipient) salesConfig)',
])
const ERC20_HUMAN = parseAbi([
  'function setSale(uint256 tokenId, (uint64 saleStart, uint64 saleEnd, uint64 maxTokensPerAddress, uint256 pricePerToken, address fundsRecipient, address currency) salesConfig)',
])

const fullEth: FullOnchainSale = {
  type: 'fixedPrice',
  strategy: ZORA_FIXED_PRICE_STRATEGY,
  ...ethRow,
}
const newWindow = { saleStart: 0n, saleEnd: OPEN_ENDED_SALE_SENTINEL }
const ethCall = buildSaleUpdateCall(7n, fullEth, newWindow)
check('ETH call targets FPSS', ethCall.strategy === ZORA_FIXED_PRICE_STRATEGY)
{
  const { functionName, args } = decodeFunctionData({ abi: FPSS_HUMAN, data: ethCall.setSaleData })
  const [tokenId, cfg] = args as [bigint, {
    saleStart: bigint
    saleEnd: bigint
    maxTokensPerAddress: bigint
    pricePerToken: bigint
    fundsRecipient: Address
  }]
  check('FPSS calldata is setSale(tokenId=7)', functionName === 'setSale' && tokenId === 7n)
  check('FPSS window written', cfg.saleStart === 0n && cfg.saleEnd === OPEN_ENDED_SALE_SENTINEL)
  check(
    'FPSS price / cap / fundsRecipient carried UNCHANGED',
    cfg.pricePerToken === ethRow.pricePerToken &&
      cfg.maxTokensPerAddress === ethRow.maxTokensPerAddress &&
      cfg.fundsRecipient === SPLITS_WALLET,
  )
  check('open-ended sentinel round-trips bit-exact', cfg.saleEnd === 18446744073709551615n)
}

const fullUsdc: FullOnchainSale = {
  type: 'erc20Mint',
  strategy: ZORA_ERC20_MINTER,
  ...usdcRow,
}
const usdcCall = buildSaleUpdateCall(9n, fullUsdc, { saleStart: 100n, saleEnd: 200n })
check('USDC call targets ERC20Minter', usdcCall.strategy === ZORA_ERC20_MINTER)
{
  const { args } = decodeFunctionData({ abi: ERC20_HUMAN, data: usdcCall.setSaleData })
  const [, cfg] = args as [bigint, {
    saleStart: bigint
    saleEnd: bigint
    maxTokensPerAddress: bigint
    pricePerToken: bigint
    fundsRecipient: Address
    currency: Address
  }]
  check('ERC20 window written', cfg.saleStart === 100n && cfg.saleEnd === 200n)
  check(
    'ERC20 price / cap / fundsRecipient / CURRENCY carried UNCHANGED',
    cfg.pricePerToken === usdcRow.pricePerToken &&
      cfg.maxTokensPerAddress === usdcRow.maxTokensPerAddress &&
      cfg.fundsRecipient === SPLITS_WALLET &&
      cfg.currency === USDC_BASE,
  )
}

let threw = false
try {
  buildSaleUpdateCall(1n, { ...fullUsdc, currency: undefined }, newWindow)
} catch {
  threw = true
}
check('ERC20 row missing currency -> throws (never encode a zero currency)', threw)

// ── 5. saleToDisplayConfig — what the optimistic UI + caches consume ────────
const disp = saleToDisplayConfig(fullEth, newWindow)
check(
  'display config strings + type',
  disp.type === 'fixedPrice' &&
    disp.pricePerToken === ethRow.pricePerToken.toString() &&
    disp.saleStart === '0',
)
check(
  'display open-ended saleEnd classifies as no deadline (shared classifier)',
  parseRealSaleEnd(disp.saleEnd) === null,
)
check('fixedPrice display config has no currency key', !('currency' in disp))
const dispUsdc = saleToDisplayConfig(fullUsdc, { saleStart: 100n, saleEnd: 200n })
check('erc20 display config carries currency', dispUsdc.currency === USDC_BASE)
check(
  'real close date survives to display seconds',
  parseRealSaleEnd(dispUsdc.saleEnd) === 200,
)

console.log(failures === 0 ? '\nAll sale-edit checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
