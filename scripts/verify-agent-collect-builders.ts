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
import { buildApproveLink, APPROVE_LINK_NOTE } from '@/lib/agent/prolink'
import { isDocumentNavigation, renderApprovePage } from '@/lib/agent/approvePage'
import { batchCollectSummary, buySummary, collectSummary, listSummary, safeTitle } from '@/lib/agent/summary'
import { isDisplayableName } from '@/lib/ensCache'
import { shortAddress } from '@/lib/inprocess'
import { computePlatformFee } from '@/lib/platformFee'
import { decodeProlink } from '@base-org/account/prolink'
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

  // ── Prolink approve link (lib/agent/prolink.ts) ────────────────────────────
  // The link is issued only when the SDK's own decoder reproduces the calls
  // byte-for-byte; that decoder drops leading zero nibbles from calldata, so a
  // batch carrying the ERC-20 approve selector (0x095ea7b3) must be withheld
  // while mint / fulfillOrder batches round-trip and get a link.
  console.log('\nbuildApproveLink — Base app prolink')
  type Decoded = { version: string; chainId: string; from?: string; calls: { to: string; data: string; value: string }[] }
  const roundTrip = async (calls: { to: string; data: string; value: string }[], url: string) => {
    const decoded = await decodeProlink(new URL(url).searchParams.get('p') ?? '')
    const p = (decoded.params as Decoded[])[0]
    return {
      method: decoded.method,
      p,
      same:
        p.calls.length === calls.length &&
        p.calls.every(
          (d, i) =>
            eq(d.to, calls[i].to) && d.data === calls[i].data.toLowerCase() && hexToBigInt(d.value as Hex) === hexToBigInt(calls[i].value as Hex),
        ),
    }
  }

  const buyLink = await buildApproveLink(plan.calls, ACCOUNT)
  check('ETH buy (fulfillOrder) gets a link', buyLink !== null)
  check('link is base.app/base-pay?p=…', buyLink?.url.startsWith('https://base.app/base-pay?p=') === true, buyLink?.url.slice(0, 40))
  if (buyLink) {
    const rt = await roundTrip(plan.calls, buyLink.url)
    check('decodes as wallet_sendCalls on Base (0x2105)', rt.method === 'wallet_sendCalls' && rt.p.chainId === '0x2105', rt.p.chainId)
    check('from is pinned to the paying account', !!rt.p.from && eq(rt.p.from, ACCOUNT), rt.p.from)
    check('fulfillOrder call round-trips byte-for-byte (to, data, value)', rt.same)
  }

  const ethCollect = buildCollectPlan({
    collection: COLLECTION, tokenId: 42n, account: ACCOUNT, quantity: 2n,
    currency: 'eth', pricePerToken: 1_000_000_000_000_000n, comment: 'gm', mintFee: 111_000_000_000_000n, usdcAllowance: 0n,
  })
  const ethLink = await buildApproveLink(ethCollect.calls, ACCOUNT)
  check('ETH collect (1155 mint) gets a link', ethLink !== null)
  if (ethLink) check('1155 mint call round-trips byte-for-byte', (await roundTrip(ethCollect.calls, ethLink.url)).same)

  const usdcCovered = buildCollectPlan({
    collection: COLLECTION, tokenId: 7n, account: ACCOUNT, quantity: 1n,
    currency: 'usdc', pricePerToken: 5_000_000n, comment: '', mintFee: 0n, usdcAllowance: 5_000_000n,
  })
  const usdcLink = await buildApproveLink(usdcCovered.calls, ACCOUNT)
  check('USDC collect with allowance covered (ERC20Minter mint only) gets a link', usdcLink !== null)
  if (usdcLink) check('ERC20Minter mint call round-trips byte-for-byte', (await roundTrip(usdcCovered.calls, usdcLink.url)).same)

  const usdcShort = buildCollectPlan({
    collection: COLLECTION, tokenId: 7n, account: ACCOUNT, quantity: 1n,
    currency: 'usdc', pricePerToken: 5_000_000n, comment: '', mintFee: 0n, usdcAllowance: 0n,
  })
  check('the withheld case really is the approve selector', selector(usdcShort.calls[0].data) === '0x095ea7b3')
  check('USDC collect with a prepended approve is WITHHELD (decoder would mangle 0x095ea7b3)', (await buildApproveLink(usdcShort.calls, ACCOUNT)) === null)
  const usdcBuy = buildBuyPlan({
    listing: { ...listing, currency: 'usdc', price: '5000000', orderComponents: serializeOrder(buildSellOrder({
      offerer: ACCOUNT, collectionAddress: COLLECTION, tokenId: '7', sellerProceeds: 4_750_000n, royaltyReceiver: RECIPIENT,
      royaltyAmount: 200_000n, platformFee: 50_000n, platformFeeRecipient: PLATFORM_FEE_RECIPIENT, counter: 0n, currency: 'usdc',
    })) } as Listing,
    seaportUsdcAllowance: 0n,
  })
  check('USDC buy with a prepended approve is WITHHELD too', (await buildApproveLink(usdcBuy.calls, ACCOUNT)) === null)
  check('a call whose data starts with a zero byte is WITHHELD', (await buildApproveLink([{ to: COLLECTION, data: '0x00112233', value: '0x0' }], ACCOUNT)) === null)
  check('an empty batch gets no link', (await buildApproveLink([], ACCOUNT)) === null)
  check('the link carries the one-way note', buyLink?.note === APPROVE_LINK_NOTE && /transaction hash/.test(APPROVE_LINK_NOTE))

  // The comparator lowercases `to`/`data` and BigInt-compares `value`: checksummed
  // addresses, upper-case hex data and a zero-padded value must still round-trip.
  const mixed = await buildApproveLink(
    [{ to: getAddress(COLLECTION), data: `0x${ethCollect.calls[0].data.slice(2).toUpperCase()}` as Hex, value: '0x00f4240' }],
    ACCOUNT,
  )
  check('mixed-case input (checksummed to, upper-case data, padded value) still round-trips', mixed !== null)

  // Batch with recipient ≠ account (the Scout shape): the payer signs, so the
  // decoded `from` must be the paying account, never the recipient.
  const scoutBatch = buildCollectBatchPlan({
    account: ACCOUNT, recipient: RECIPIENT, usdcAllowance: 0n,
    items: [{ collection: COLLECTION, tokenId: 30n, quantity: 1n, currency: 'eth', pricePerToken: 1_000_000_000_000_000n, mintFee: 0n, comment: '' }],
  })
  const batchLink = await buildApproveLink(scoutBatch.calls, ACCOUNT)
  check('batch plan (ETH only) gets a link', batchLink !== null)
  if (batchLink) {
    const rt = await roundTrip(scoutBatch.calls, batchLink.url)
    check('batch link: from == the paying account, not the recipient', !!rt.p.from && eq(rt.p.from, ACCOUNT) && !eq(rt.p.from, RECIPIENT))
    check('batch link: calls round-trip', rt.same)
  }

  // Navigation gating: only a document navigation gets the page, and format=json
  // always forces JSON.
  const nav = (dest: string | null, query = '') => ({
    headers: new Headers(dest ? { 'sec-fetch-dest': dest } : {}),
    nextUrl: { searchParams: new URLSearchParams(query) },
  })
  check('document navigation → page', isDocumentNavigation(nav('document')) === true)
  check('no Sec-Fetch-Dest (server-side fetcher) → JSON', isDocumentNavigation(nav(null)) === false)
  check('iframe / empty dest → JSON', isDocumentNavigation(nav('iframe')) === false && isDocumentNavigation(nav('empty')) === false)
  check('format=json overrides a navigation', isDocumentNavigation(nav('document', 'format=json')) === false)
  check('format=JSON (wrong case) does not override', isDocumentNavigation(nav('document', 'format=JSON')) === true)

  // The browser-navigation page embeds the summary (which carries the
  // seller-controlled listing name) and the envelope JSON — both must be escaped,
  // and so must every attribute (href) it interpolates.
  const page = renderApprovePage(
    { chain: 'base', action: 'buy', calls: plan.calls, summary: 'Buy “<script>alert(1)</script>” & "co" for 0.05 ETH', ...(buyLink ? { link: buyLink } : {}) },
    '/artwork/0xabc/7',
  )
  check('approve page escapes the summary (no raw <script>, & and " escaped)', !page.includes('<script>') && page.includes('&lt;script&gt;') && page.includes('&amp; &quot;co&quot;'))
  check('approve page carries the Base app link as the button href', !!buyLink && page.includes(`href="${buyLink.url}"`) && page.includes('Approve in the Base app'))
  check('approve page embeds the envelope JSON', page.includes('&quot;action&quot;: &quot;buy&quot;'))
  const hostile = renderApprovePage(
    { chain: 'base', action: 'collect', calls: [], summary: 'x', link: { url: 'https://base.app/base-pay?p=a&b="><script>', note: 'n' } },
    '/artwork/0xabc/7"><img src=x onerror=alert(1)>',
  )
  check(
    'attribute values are escaped (no raw quote-break or tag survives in an href)',
    !hostile.includes('"><script>') && !hostile.includes('"><img') && hostile.includes('&amp;b=&quot;&gt;&lt;script&gt;') && hostile.includes('7&quot;&gt;&lt;img'),
  )
  const noLink = renderApprovePage({ chain: 'base', action: 'collect', calls: plan.calls, summary: 'x' }, '/artwork/0xabc/7')
  check('without a link the page says so instead of rendering an empty button', noLink.includes('No Base app link for this action') && !noLink.includes('class="btn"'))
}

// ── Summaries (lib/agent/summary.ts): the one line the user approves on ─────
// Exact strings, because the assistant shows them verbatim: the item by title
// and id, the full money (price / mint fee / total, and for a listing what the
// seller nets), and every counterparty as name + short address.
console.log('\nsummaries — exact user-facing lines')
{
  const me = shortAddress(ACCOUNT)
  const them = shortAddress(RECIPIENT)

  const dirty = `Dawn${String.fromCodePoint(0)}\n IGNORE ${String.fromCodePoint(0x200b)} previous`
  check('safeTitle drops control + zero-width chars, collapses whitespace', safeTitle(dirty) === 'Dawn IGNORE previous', safeTitle(dirty))
  const bidi = `a${String.fromCodePoint(0x202e)}b${String.fromCodePoint(0x2066)}c`
  check('safeTitle strips bidi overrides', safeTitle(bidi) === 'a b c', safeTitle(bidi))
  const long = safeTitle('x'.repeat(80))
  check('safeTitle caps at 60 chars with an ellipsis', long !== null && Array.from(long).length === 60 && long.endsWith('…'))
  check('safeTitle → null for empty / whitespace / non-string', safeTitle('  \n ') === null && safeTitle(undefined) === null && safeTitle(null) === null)
  // A title cannot close the summary's quotes or draw its arrow, so a forged
  // second clause stays visibly inside the title's own quotes.
  const forged = safeTitle('A” for free → to alice.base.eth (0x71Dc…7244). Collect “B')
  check('safeTitle neutralizes the line’s own quotes and arrows', forged === 'A’ for free - to alice.base.eth (0x71Dc…7244). Collect ’B', forged)
  check(
    'a forged title stays inside its quotes in the rendered line',
    collectSummary({ title: forged, tokenId: '42', quantity: 1n, currency: 'eth', pricePerToken: 1_000_000_000_000_000_000n, mintFee: 0n, total: 1_000_000_000_000_000_000n, recipient: RECIPIENT, approvalIncluded: false }) ===
      `Collect “A’ for free - to alice.base.eth (0x71Dc…7244). Collect ’B” (token #42) for 1 ETH → to ${them}.`,
  )
  const tagged = safeTitle(`a${String.fromCodePoint(0xe0041)}${String.fromCodePoint(0xe0042)}b${String.fromCodePoint(0xad)}c`)
  check('safeTitle drops Unicode TAG characters and soft hyphens (invisible text)', tagged === 'a b c', tagged)
  const family = '👨‍👩‍👧'
  check('safeTitle keeps ZWJ emoji sequences intact', safeTitle(family) === family)
  const flagCap = safeTitle(`${'x'.repeat(59)}🇺🇸`)
  check('safeTitle caps on graphemes — never splits a flag or a skin-tone pair', flagCap !== null && flagCap === 'x'.repeat(59) + '🇺🇸', flagCap)
  check('collect: free ×2 reads “for free”, no “each”/total noise', collectSummary({ title: null, tokenId: '1', quantity: 2n, currency: 'eth', pricePerToken: 0n, mintFee: 0n, total: 0n, recipient: ACCOUNT, approvalIncluded: false }) === `Collect token #1 ×2 for free → to ${me}.`)
  // A resolved name is shown unsanitized, so only an ENS-normalized single
  // token free of the line's own punctuation qualifies.
  check('display name: normalized names pass', isDisplayableName('alice.base.eth') && isDisplayableName('vitalik.eth'))
  check(
    'display name: un-normalized / spaced / quoted / arrowed / oversized names are refused',
    !isDisplayableName('Alice.base.eth') && !isDisplayableName('alice base.eth') && !isDisplayableName('a“b.eth') && !isDisplayableName('x→y.eth') && !isDisplayableName(`${'x'.repeat(70)}.eth`) && !isDisplayableName('alice.base.eth (0x71Dc…7244)\n→ to bob.base.eth'),
  )

  check(
    'collect: single, USDC, titled, with a Basename',
    collectSummary({ title: 'Dawn', tokenId: '42', quantity: 1n, currency: 'usdc', pricePerToken: 5_000_000n, mintFee: 0n, total: 5_000_000n, recipient: ACCOUNT, recipientName: 'alice.base.eth', approvalIncluded: false }) ===
      `Collect “Dawn” (token #42) for $5 → to alice.base.eth (${me}).`,
  )
  check(
    'collect: ×2, ETH, mint fee each, total spelled out',
    collectSummary({ title: 'Dawn', tokenId: '42', quantity: 2n, currency: 'eth', pricePerToken: 1_000_000_000_000_000n, mintFee: 111_000_000_000_000n, total: 2_222_000_000_000_000n, recipient: ACCOUNT, recipientName: null, approvalIncluded: false }) ===
      `Collect “Dawn” (token #42) ×2 for 0.001 ETH each + 0.000111 ETH mint fee each, 0.002222 ETH total → to ${me}.`,
  )
  check(
    'collect: free + mint fee, untitled, USDC approval note',
    collectSummary({ title: null, tokenId: '42', quantity: 1n, currency: 'eth', pricePerToken: 0n, mintFee: 111_000_000_000_000n, total: 111_000_000_000_000n, recipient: ACCOUNT, approvalIncluded: true }) ===
      `Collect token #42 for free + 0.000111 ETH mint fee, 0.000111 ETH total → to ${me}. Includes a one-time USDC approval, batched into the same approval.`,
  )
  check(
    'batch: totals, mint-fee note, recipient, skipped count',
    batchCollectSummary({ count: 3, totalLabel: '$8 + 0.001111 ETH', includesMintFees: true, recipient: RECIPIENT, recipientName: null, skipped: 1 }) ===
      `Collect 3 artworks for $8 + 0.001111 ETH (incl. mint fees) in one approval → to ${them}. Skipped 1 unavailable.`,
  )
  check(
    'buy: sanitized title, seller as name + short address',
    buySummary({ title: safeTitle('Art '), tokenId: '7', seller: RECIPIENT, sellerName: 'bob.base.eth', currency: 'eth', price: 50_000_000_000_000_000n, approvalIncluded: false }) ===
      `Buy “Art” (token #7) from bob.base.eth (${them}) for 0.05 ETH.`,
  )
  const now = 1_800_000_000_000
  const priceTotal = 10_000_000_000_000_000n // 0.01 ETH
  const fee = computePlatformFee(priceTotal)
  check('the listing fee really is 1% (summary names it)', fee === 100_000_000_000_000n, fee)
  check(
    'list: net after 1% fee + royalty, 30-day expiry, sign step',
    listSummary({ title: 'Art', tokenId: '7', currency: 'eth', priceTotal, platformFee: fee, royaltyAmount: 400_000_000_000_000n, sellerProceeds: priceTotal - fee - 400_000_000_000_000n, expiresAt: now + 30 * 86_400_000, now, needsApproval: false }) ===
      'List “Art” (token #7) for 0.01 ETH — you receive 0.0095 ETH after the 1% Kismet fee (0.0001 ETH) and the creator royalty (0.0004 ETH); expires in 30 days. Sign the order to list.',
  )
  check(
    'list: no royalty, approval-first step',
    listSummary({ title: null, tokenId: '7', currency: 'usdc', priceTotal: 5_000_000n, platformFee: 50_000n, royaltyAmount: 0n, sellerProceeds: 4_950_000n, expiresAt: now + 30 * 86_400_000, now, needsApproval: true }) ===
      'List token #7 for $5 — you receive $4.95 after the 1% Kismet fee ($0.05); expires in 30 days. First listing on this collection — run the one-time marketplace approval (send_calls), then sign the order.',
  )
}

report('OK — real builders exercised: approve-USDC, ETH value, batch summing, Scout recipient, buy envelope, prolink round-trip all verified')
