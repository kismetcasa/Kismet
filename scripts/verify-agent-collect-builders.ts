// Real-builder oracle for the agent collect AND buy paths. UNLIKE
// verify-agent-collect.ts / verify-agent-buy.ts / verify-agent-collect-batch.ts
// — which independently re-derive the expected calldata by hand — this
// exercises the ACTUAL production functions buildCollectPlan
// (lib/agent/collect.ts), buildCollectBatchPlan (lib/agent/collectBatch.ts),
// and buildBuyPlan (lib/agent/buy.ts), so a regression INSIDE those builders
// (wrong approve spender, dropped allowance guard, per-item approves, wrong
// amount, mis-set envelope value, recipient/sender mixups) fails CI instead
// of slipping through.
//
// The two oracles are complementary: the hand-derivation pins the intended
// SHAPE against production treasury constants; this pins the builders' actual
// OUTPUT. Both must agree.
//
// Importing the builders needs the `@/` alias, which plain
// `node --experimental-strip-types` can't resolve — so this script is run with
// the alias hook:
//   node --experimental-strip-types --import ./scripts/register-ts-alias.mjs scripts/verify-agent-collect-builders.ts
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  hexToBigInt,
  parseAbiParameters,
  type Hex,
} from 'viem'
import {
  ERC20_ABI,
  ERC20_MINTER,
  ERC20_MINTER_ABI,
  FPSS,
  MINT_1155_ABI,
  REFERRAL,
  USDC,
  builderSuffix,
  check,
  eq,
  report,
  selector,
} from './_agent-verify-helpers.ts'
import { buildCollectPlan } from '@/lib/agent/collect'
import { buildCollectBatchPlan } from '@/lib/agent/collectBatch'
import { buildBuyPlan } from '@/lib/agent/buy'
import { SEAPORT_ADDRESS, buildSellOrder, serializeOrder } from '@/lib/seaport'
import { PLATFORM_FEE_RECIPIENT } from '@/lib/platformFee'
import type { Listing } from '@/lib/listings'

const ACCOUNT = getAddress('0x71Dc000000000000000000000000000000007244')
const RECIPIENT = getAddress('0x71dc000000000000000000000000000000009999')
const COLLECTION = getAddress('0x00000000000000000000000000000000c011ec70')
const COL_B = getAddress('0x00000000000000000000000000000000c0011ebb')

// The well-known approve(address,uint256) selector, derived (not hardcoded) so
// an ABI drift can't silently mis-identify calls.
const APPROVE_SEL = selector(encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [ERC20_MINTER, 0n] }))

// Strip the ERC-8021 builder suffix the production builders append, so
// decodeFunctionData sees exactly the ABI-encoded call (works regardless of
// dynamic arg lengths, unlike a fixed-width slice).
const suffix = builderSuffix.slice(2)
const strip = (data: Hex): Hex => (data.endsWith(suffix) ? (data.slice(0, data.length - suffix.length) as Hex) : data)
const hasSuffix = (data: Hex): boolean => data.endsWith(suffix)
const decodeApprove = (data: Hex) => decodeFunctionData({ abi: ERC20_ABI, data: strip(data) })
const decodeUsdcMint = (data: Hex) => decodeFunctionData({ abi: ERC20_MINTER_ABI, data: strip(data) })
const decodeEthMint = (data: Hex) => decodeFunctionData({ abi: MINT_1155_ABI, data: strip(data) })

// ── Single USDC collect, allowance short → [approve(ERC20Minter, total), mint]
console.log('buildCollectPlan — USDC, allowance short')
{
  const plan = buildCollectPlan({
    collection: COLLECTION, tokenId: 7n, account: ACCOUNT, quantity: 3n,
    currency: 'usdc', pricePerToken: 5_000_000n, comment: 'gm', mintFee: 0n, usdcAllowance: 0n,
  })
  check('two calls (approve + mint)', plan.calls.length === 2, plan.calls.length)
  check('approvalIncluded flag set', plan.approvalIncluded === true)
  check('totalValue is 0 for USDC (paid via allowance)', plan.totalValue === 0n, plan.totalValue)
  check('totalCost == price*qty (15 USDC)', plan.totalCost === 15_000_000n, plan.totalCost)

  const [approve, mint] = plan.calls
  check('approve is the FIRST call', selector(approve.data) === APPROVE_SEL)
  check('approve call targets the USDC token', eq(approve.to, USDC), approve.to)
  check('approve carries no native value', approve.value === '0x0', approve.value)
  const da = decodeApprove(approve.data)
  check('approve spender is the ERC20Minter (NOT the collection)', eq(da.args[0], ERC20_MINTER), da.args[0])
  check('approve amount == exact total (never MaxUint256)', da.args[1] === 15_000_000n, da.args[1])

  check('mint call targets the ERC20Minter', eq(mint.to, ERC20_MINTER), mint.to)
  check('mint carries no native value', mint.value === '0x0', mint.value)
  const dm = decodeUsdcMint(mint.data)
  check('mint.mintTo == account', eq(dm.args[0], ACCOUNT), dm.args[0])
  check('mint.quantity == 3', dm.args[1] === 3n, dm.args[1])
  check('mint.tokenAddress == collection', eq(dm.args[2], COLLECTION), dm.args[2])
  check('mint.tokenId == 7', dm.args[3] === 7n, dm.args[3])
  check('mint.totalValue == price*qty', dm.args[4] === 15_000_000n, dm.args[4])
  check('mint.currency == USDC', eq(dm.args[5], USDC), dm.args[5])
  check('mint.mintReferral == KISMET_REFERRAL (treasury)', eq(dm.args[6], REFERRAL), dm.args[6])
  check('both calls carry the ERC-8021 builder suffix', hasSuffix(approve.data) && hasSuffix(mint.data))
}

// ── Single USDC collect, allowance already sufficient → [mint] only ──────────
console.log('\nbuildCollectPlan — USDC, allowance already covers cost')
{
  const plan = buildCollectPlan({
    collection: COLLECTION, tokenId: 7n, account: ACCOUNT, quantity: 3n,
    currency: 'usdc', pricePerToken: 5_000_000n, comment: '', mintFee: 0n, usdcAllowance: 15_000_000n,
  })
  check('one call (mint only, no approve)', plan.calls.length === 1, plan.calls.length)
  check('approvalIncluded flag false', plan.approvalIncluded === false)
  check('the single call is the ERC20Minter mint', eq(plan.calls[0].to, ERC20_MINTER))
}

// ── Single USDC collect, PARTIAL allowance → approve the FULL total ──────────
console.log('\nbuildCollectPlan — USDC, partial allowance → approve full total')
{
  const plan = buildCollectPlan({
    collection: COLLECTION, tokenId: 7n, account: ACCOUNT, quantity: 3n,
    currency: 'usdc', pricePerToken: 5_000_000n, comment: '', mintFee: 0n, usdcAllowance: 4_000_000n,
  })
  check('approve prepended (allowance < cost)', plan.approvalIncluded === true && plan.calls.length === 2)
  check('approve amount is the FULL total, not the shortfall', decodeApprove(plan.calls[0].data).args[1] === 15_000_000n)
}

// ── Single ETH collect → one mint on the collection, value=(fee+price)*qty ───
console.log('\nbuildCollectPlan — ETH')
{
  const plan = buildCollectPlan({
    collection: COLLECTION, tokenId: 42n, account: ACCOUNT, quantity: 2n,
    currency: 'eth', pricePerToken: 1_000_000_000_000_000n, comment: '', mintFee: 111_000_000_000_000n, usdcAllowance: 0n,
  })
  check('one call, no approve', plan.calls.length === 1 && plan.approvalIncluded === false)
  const mint = plan.calls[0]
  check('mint targets the collection (1155)', eq(mint.to, COLLECTION), mint.to)
  check('value == (mintFee + price) * qty', hexToBigInt(mint.value as Hex) === (111_000_000_000_000n + 1_000_000_000_000_000n) * 2n)
  const dm = decodeEthMint(mint.data)
  check('mint.minter is the FixedPriceStrategy', eq(dm.args[0], FPSS), dm.args[0])
  check('mint.rewardsRecipients == [KISMET_REFERRAL]', dm.args[3].length === 1 && eq(dm.args[3][0], REFERRAL))
  const [mintTo] = decodeAbiParameters(parseAbiParameters('address, string'), dm.args[4])
  check('minterArguments.mintTo == account', eq(mintTo, ACCOUNT), mintTo)
}

// ── Batch: 2 USDC + 1 ETH, allowance short → ONE summed approve, first ───────
console.log('\nbuildCollectBatchPlan — mixed basket, allowance short')
{
  const ethValue = 111_000_000_000_000n + 1_000_000_000_000_000n
  const plan = buildCollectBatchPlan({
    account: ACCOUNT, usdcAllowance: 0n,
    items: [
      { collection: COLLECTION, tokenId: 10n, quantity: 1n, currency: 'usdc', pricePerToken: 5_000_000n, mintFee: 0n, comment: '' },
      { collection: COL_B, tokenId: 20n, quantity: 1n, currency: 'usdc', pricePerToken: 3_000_000n, mintFee: 0n, comment: '' },
      { collection: COLLECTION, tokenId: 30n, quantity: 1n, currency: 'eth', pricePerToken: 1_000_000_000_000_000n, mintFee: 111_000_000_000_000n, comment: '' },
    ],
  })
  const approves = plan.calls.filter((c) => selector(c.data) === APPROVE_SEL)
  check('exactly ONE approve for the whole basket (not per-item)', approves.length === 1, approves.length)
  check('the approve is the FIRST call', selector(plan.calls[0].data) === APPROVE_SEL)
  check('usdcApproveIncluded flag set', plan.usdcApproveIncluded === true)
  const da = decodeApprove(approves[0].data)
  check('approve spender is the ERC20Minter', eq(da.args[0], ERC20_MINTER))
  check('approve amount == SUM of USDC costs (8 USDC)', da.args[1] === 8_000_000n, da.args[1])
  check('totalUsdcCost == 8 USDC', plan.totalUsdcCost === 8_000_000n, plan.totalUsdcCost)
  check('totalNativeValue == the single ETH leg', plan.totalNativeValue === ethValue, plan.totalNativeValue)

  const usdcMints = plan.calls.filter((c) => eq(c.to, ERC20_MINTER) && c.value === '0x0')
  check('two USDC mints on the ERC20Minter, value 0x0', usdcMints.length === 2, usdcMints.length)
  const ethMint = plan.calls.find((c) => eq(c.to, COLLECTION) && c.value !== '0x0')
  check('ETH leg carries its own hex-wei value', !!ethMint && hexToBigInt(ethMint.value as Hex) === ethValue)
  check('every call carries the builder suffix', plan.calls.every((c) => hasSuffix(c.data)))
}

// ── Batch: allowance already covers the sum → no approve ─────────────────────
console.log('\nbuildCollectBatchPlan — allowance covers the sum → no approve')
{
  const plan = buildCollectBatchPlan({
    account: ACCOUNT, usdcAllowance: 8_000_000n,
    items: [
      { collection: COLLECTION, tokenId: 10n, quantity: 1n, currency: 'usdc', pricePerToken: 5_000_000n, mintFee: 0n, comment: '' },
      { collection: COL_B, tokenId: 20n, quantity: 1n, currency: 'usdc', pricePerToken: 3_000_000n, mintFee: 0n, comment: '' },
    ],
  })
  check('no approve prepended', plan.usdcApproveIncluded === false)
  check('exactly the two mints, both on the ERC20Minter', plan.calls.length === 2 && plan.calls.every((c) => eq(c.to, ERC20_MINTER)))
}

// ── Batch: recipient != account (autonomous Scout) → mintTo is the recipient ─
console.log('\nbuildCollectBatchPlan — Scout: sender pays, recipient receives')
{
  const plan = buildCollectBatchPlan({
    account: ACCOUNT, recipient: RECIPIENT, usdcAllowance: 0n,
    items: [
      { collection: COLLECTION, tokenId: 10n, quantity: 1n, currency: 'usdc', pricePerToken: 5_000_000n, mintFee: 0n, comment: '' },
      { collection: COLLECTION, tokenId: 30n, quantity: 1n, currency: 'eth', pricePerToken: 1_000_000_000_000_000n, mintFee: 0n, comment: '' },
    ],
  })
  const usdcMint = plan.calls.find((c) => eq(c.to, ERC20_MINTER))
  check('USDC mint.mintTo == recipient, not the paying account', !!usdcMint && eq(decodeUsdcMint(usdcMint.data).args[0], RECIPIENT))
  const ethMint = plan.calls.find((c) => eq(c.to, COLLECTION))
  const [ethMintTo] = ethMint ? decodeAbiParameters(parseAbiParameters('address, string'), decodeEthMint(ethMint.data).args[4]) : [undefined]
  check('ETH mint.mintTo == recipient, not the paying account', !!ethMint && eq(ethMintTo as string, RECIPIENT))
  check('mintTo != the paying account (sender)', !eq(RECIPIENT, ACCOUNT))
}

// ── Buy: the real buildBuyPlan — USDC fulfill carries NO native value ────────
// This is the envelope-level invariant the hand-derivation oracle
// (verify-agent-buy.ts) structurally cannot assert: `value` lives on the call
// envelope, not in calldata. A regression that copies the ETH path's
// value-carrying call onto the USDC path would charge the buyer ETH on top of
// their USDC approval.
console.log('\nbuildBuyPlan — USDC listing, allowance short')
{
  const price = 5_000_000n // 5 USDC
  const order = buildSellOrder({
    offerer: ACCOUNT,
    collectionAddress: COLLECTION,
    tokenId: '7',
    sellerProceeds: price - 200_000n - 50_000n,
    royaltyReceiver: RECIPIENT,
    royaltyAmount: 200_000n,
    platformFee: 50_000n,
    platformFeeRecipient: PLATFORM_FEE_RECIPIENT,
    counter: 0n,
    currency: 'usdc',
  })
  const listing = {
    price: price.toString(),
    currency: 'usdc',
    orderComponents: serializeOrder(order),
    signature: `0x${'ab'.repeat(65)}`,
  } as Listing

  const plan = buildBuyPlan({ listing, seaportUsdcAllowance: 0n })
  check('two calls (approve + fulfill)', plan.calls.length === 2, plan.calls.length)
  check('approvalIncluded flag set', plan.approvalIncluded === true)
  const [approve, fulfill] = plan.calls
  const da = decodeApprove(approve.data)
  check('approve targets USDC, spender is Seaport, exact price', eq(approve.to, USDC), da.args[1] === price && eq(da.args[0], SEAPORT_ADDRESS))
  check('approve carries no native value', approve.value === '0x0', approve.value)
  check('fulfill targets Seaport', eq(fulfill.to, SEAPORT_ADDRESS), fulfill.to)
  check('USDC fulfill carries NO native value', fulfill.value === '0x0', fulfill.value)
  check('totalValue is 0 for USDC', plan.totalValue === 0n, plan.totalValue)
  check('both calls carry the builder suffix', hasSuffix(approve.data) && hasSuffix(fulfill.data))

  const covered = buildBuyPlan({ listing, seaportUsdcAllowance: price })
  check('allowance covers price → fulfill only, no approve', covered.calls.length === 1 && covered.approvalIncluded === false)
}

console.log('\nbuildBuyPlan — ETH listing carries value == price')
{
  const price = 50_000_000_000_000_000n // 0.05 ETH
  const order = buildSellOrder({
    offerer: ACCOUNT,
    collectionAddress: COLLECTION,
    tokenId: '7',
    sellerProceeds: price - 2_000_000_000_000_000n - 500_000_000_000_000n,
    royaltyReceiver: RECIPIENT,
    royaltyAmount: 2_000_000_000_000_000n,
    platformFee: 500_000_000_000_000n,
    platformFeeRecipient: PLATFORM_FEE_RECIPIENT,
    counter: 0n,
    currency: 'eth',
  })
  const listing = {
    price: price.toString(),
    currency: 'eth',
    orderComponents: serializeOrder(order),
    signature: `0x${'ab'.repeat(65)}`,
  } as Listing

  const plan = buildBuyPlan({ listing, seaportUsdcAllowance: 0n })
  check('single fulfill call, no approve', plan.calls.length === 1 && plan.approvalIncluded === false)
  check('ETH fulfill value == price', hexToBigInt(plan.calls[0].value as Hex) === price)
  check('totalValue == price', plan.totalValue === price)
}

report('OK — real builders exercised: approve-USDC, ETH value, batch summing, Scout recipient, buy envelope all verified')
