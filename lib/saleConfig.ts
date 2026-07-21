import type { Address, Chain, Client, Transport } from 'viem'
import { getBlock, multicall, readContract } from 'viem/actions'
import {
  USDC_BASE,
  ZORA_1155_TOKEN_INFO_ABI,
  ZORA_ERC20_MINTER,
  ZORA_FIXED_PRICE_STRATEGY,
  isOpenEdition,
} from './zoraMint'

// FixedPriceSaleStrategy.sale(target, tokenId) — the canonical view returning
// the SalesConfig struct (see zora protocol-deployments). Tokens whose sale
// row is unset return zeros, which we treat as "no ETH sale configured".
const FPSS_SALE_ABI = [
  {
    name: 'sale',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenContract', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'saleStart', type: 'uint64' },
          { name: 'saleEnd', type: 'uint64' },
          { name: 'maxTokensPerAddress', type: 'uint64' },
          { name: 'pricePerToken', type: 'uint96' },
          { name: 'fundsRecipient', type: 'address' },
        ],
      },
    ],
  },
] as const

// ERC20Minter.sale(target, tokenId) — analog of FPSS_SALE_ABI but with
// pricePerToken widened to uint256 and a trailing currency field. We treat
// currency != USDC_BASE as ineligible (collect-all only supports USDC for
// the ERC20 path; other ERC20s would need their own approve/decimals logic).
//
// ABI provenance: matches the SalesConfig struct in Zora's IERC20Minter.sol
// (zora-protocol monorepo, packages/protocol-rewards/src/erc20-minter).
// Verify against the deployed contract at ZORA_ERC20_MINTER on Base by
// reading getABIs from BaseScan or running:
//   cast interface 0xE27d9Dc88dAB82ACa3ebC49895c663C6a0CfA014 --rpc-url base
// If the on-chain ABI ever drifts, the USDC path returns [] — the ETH leg
// keeps working, so this fails closed (graceful degradation).
const ERC20_MINTER_SALE_ABI = [
  {
    name: 'sale',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenContract', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'saleStart', type: 'uint64' },
          { name: 'saleEnd', type: 'uint64' },
          { name: 'maxTokensPerAddress', type: 'uint64' },
          { name: 'pricePerToken', type: 'uint256' },
          { name: 'fundsRecipient', type: 'address' },
          { name: 'currency', type: 'address' },
        ],
      },
    ],
  },
] as const

const ERC1155_BALANCE_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'id', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const

export interface EligibleToken {
  tokenId: bigint
  pricePerToken: bigint
  maxPerAddress: bigint
  /** The `account`'s current balance of this token (0 when no account was
   *  passed). Lets the agent size a multi-edition top-up without a second read. */
  ownedBalance: bigint
  /** Editions left to mint (maxSupply − totalMinted); undefined for open editions
   *  or contracts without getTokenInfo. The drop coordinator bounds round-robin by
   *  this. */
  remainingSupply?: bigint
}

export type SaleCurrency = 'eth' | 'usdc'

const STRATEGY_BY_CURRENCY = {
  eth: { address: ZORA_FIXED_PRICE_STRATEGY, abi: FPSS_SALE_ABI },
  usdc: { address: ZORA_ERC20_MINTER, abi: ERC20_MINTER_SALE_ABI },
} as const

// Generic over chain so callers can pass the wagmi-typed client (Base) or
// a server-side createPublicClient without re-typing.
type AnyClient = Client<Transport, Chain | undefined>

/**
 * Filter `tokenIds` down to those currently mintable on `collection` via the
 * selected strategy:
 *   - 'eth'  → FixedPriceSaleStrategy
 *   - 'usdc' → ERC20Minter, additionally filtering currency === USDC_BASE
 *
 * When `account` is provided, also skips tokens where balance has hit
 * maxPerAddress — those would revert inside an atomic EIP-5792 bundle and
 * cascade the whole collect-all. Returns [] on any read failure so callers
 * stay simple and a USDC RPC blip can't crash the ETH leg in mixed flows.
 *
 * Two RPC round trips: one multicall for sale configs + token info, one
 * for balances. Fail-closed on balance reads so a single revert can't
 * cascade an atomic EIP-5792 bundle. The "now" used for saleStart/saleEnd
 * comparison is the chain's latest block.timestamp, not Date.now(): a
 * desynced client clock would otherwise misclassify just-expired or
 * just-started sales and feed a bundle that reverts on-chain.
 */
export async function fetchEligibleTokens(
  client: AnyClient,
  collection: Address,
  tokenIds: bigint[],
  currency: SaleCurrency,
  account?: Address,
  /** Agent edition cap: also skip a token whose `account` balance is already at
   *  or above this (e.g. 1 = "one of each new drop"). Real-time + authoritative,
   *  so it covers open editions the per-wallet-cap filter can't. Needs `account`. */
  excludeOwnedAtOrAbove?: bigint,
): Promise<EligibleToken[]> {
  if (tokenIds.length === 0) return []

  // Read chain time once; fall back to wall-clock only if the RPC denies
  // us a block read. Wall-clock can drift on misconfigured devices, but
  // it's still better than refusing to filter at all.
  let now: bigint
  try {
    const block = await getBlock(client, { blockTag: 'latest' })
    now = block.timestamp
  } catch {
    now = BigInt(Math.floor(Date.now() / 1000))
  }
  const strategy = STRATEGY_BY_CURRENCY[currency]

  // First pass: read sale config + token info for every candidate in one
  // multicall. Even-indexed slot is the sale read; odd is getTokenInfo.
  let firstPass
  try {
    firstPass = await multicall(client, {
      contracts: tokenIds.flatMap((id) => [
        {
          address: strategy.address,
          abi: strategy.abi,
          functionName: 'sale' as const,
          args: [collection, id] as const,
        },
        {
          address: collection,
          abi: ZORA_1155_TOKEN_INFO_ABI,
          functionName: 'getTokenInfo' as const,
          args: [id] as const,
        },
      ]),
      allowFailure: true,
    })
  } catch {
    return []
  }

  const candidates: EligibleToken[] = []
  for (let i = 0; i < tokenIds.length; i++) {
    const saleRes = firstPass[2 * i]
    const infoRes = firstPass[2 * i + 1]
    if (saleRes.status !== 'success' || !saleRes.result) continue
    const sale = saleRes.result as {
      saleStart: bigint
      saleEnd: bigint
      maxTokensPerAddress: bigint
      pricePerToken: bigint
      currency?: Address
    }
    if (sale.saleEnd === 0n) continue
    if (sale.saleEnd <= now) continue
    if (sale.saleStart > now) continue
    // ERC20Minter supports any ERC20; collect-all only knows how to handle
    // USDC (decimals + approve target). Skip exotic currencies cleanly.
    if (
      currency === 'usdc' &&
      sale.currency?.toLowerCase() !== USDC_BASE.toLowerCase()
    ) {
      continue
    }

    // Skip sold-out tokens. allowFailure means non-Zora-1155 contracts (or
    // older versions without getTokenInfo) just opt out of this check —
    // the mint will revert at submit time as a fallback. `remainingSupply` is
    // carried for the drop coordinator's round-robin bound (undefined = open
    // edition / unknown → unbounded by supply).
    let remainingSupply: bigint | undefined
    if (infoRes.status === 'success' && infoRes.result) {
      const info = infoRes.result as { maxSupply: bigint; totalMinted: bigint }
      if (!isOpenEdition(info.maxSupply)) {
        if (info.totalMinted >= info.maxSupply) continue
        remainingSupply = info.maxSupply - info.totalMinted
      }
    }

    candidates.push({
      tokenId: tokenIds[i],
      remainingSupply,
      pricePerToken: sale.pricePerToken,
      maxPerAddress: sale.maxTokensPerAddress,
      ownedBalance: 0n, // overwritten by the balance pass below when `account` is set
    })
  }

  if (!account || candidates.length === 0) return candidates

  // Second pass: per-account balance check to skip tokens already saturated.
  // maxPerAddress === 0 means unlimited (no filter); otherwise filter when
  // balance has hit the cap. Covers single-edition (=== 1) AND multi-edition
  // ceilings — minting +1 over the cap reverts atomically.
  //
  // Fail-closed: when `account` is provided and the per-token balance read
  // FAILS, we DROP the candidate rather than passing it through. On atomic
  // EIP-5792 wallets a single revert cascades the whole bundle, so it's
  // safer to under-include than to detonate the batch on an RPC blip.
  let balanceResults
  try {
    balanceResults = await multicall(client, {
      contracts: candidates.map((c) => ({
        address: collection,
        abi: ERC1155_BALANCE_ABI,
        functionName: 'balanceOf' as const,
        args: [account, c.tokenId] as const,
      })),
      allowFailure: true,
    })
  } catch {
    return []
  }

  const out: EligibleToken[] = []
  candidates.forEach((c, i) => {
    const r = balanceResults[i]
    if (r.status !== 'success') return
    const balance = r.result as bigint
    // Agent edition cap: already hold enough of this drop → skip (covers open
    // editions, which have no per-wallet cap to catch them below).
    if (excludeOwnedAtOrAbove !== undefined && balance >= excludeOwnedAtOrAbove) return
    if (c.maxPerAddress > 0n && balance >= c.maxPerAddress) return
    out.push({ ...c, ownedBalance: balance })
  })
  return out
}

/**
 * Read the current on-chain `pricePerToken` for a (collection, tokenId).
 * Used by the recording endpoint to derive price server-side rather than
 * trusting client-supplied display values — otherwise a malicious client
 * could record a fictional "9999 ETH" price for a free mint to fake
 * "big collect" social proof.
 *
 * Returns null on any failure (RPC error, sale not configured on this
 * strategy, exotic currency). Callers should fall back to their best-
 * known client-supplied value rather than dropping the price entirely.
 */
export async function readSalePricePerToken(
  client: AnyClient,
  collection: Address,
  tokenId: bigint,
  currency: SaleCurrency,
): Promise<bigint | null> {
  const strategy = STRATEGY_BY_CURRENCY[currency]
  try {
    const sale = await readContract(client, {
      address: strategy.address,
      abi: strategy.abi,
      functionName: 'sale',
      args: [collection, tokenId],
    })
    // Tuple shape differs per strategy but pricePerToken is the canonical
    // field on both; cast through the discriminated read to surface it.
    return (sale as { pricePerToken: bigint }).pricePerToken
  } catch {
    return null
  }
}

/**
 * Resolve the active mint sale for a single (collection, tokenId) straight
 * from chain, returning the price + currency + sale window (saleStart/saleEnd)
 * the direct-collect hook and the display fallback need.
 *
 * Probes the ETH strategy (FixedPriceSaleStrategy) first, then the USDC one
 * (ERC20Minter). A strategy whose sale row is unset returns saleEnd === 0,
 * which we treat as "no sale here" and skip (mirrors fetchEligibleTokens).
 * Returns null when neither strategy has a live row (or both reads fail) so
 * the caller can surface a clean "no active sale" message rather than guess.
 *
 * This is the authoritative fallback for the feed's best-effort display-price
 * fetch (hooks/useMomentSale): when that hasn't resolved, collect reads the
 * real price here instead of leaving its button a silent, disabled dead-end.
 */
export async function resolveOnchainSale(
  client: AnyClient,
  collection: Address,
  tokenId: bigint,
): Promise<{
  pricePerToken: bigint
  currency: SaleCurrency
  saleStart: bigint
  saleEnd: bigint
} | null> {
  // ETH — FixedPriceSaleStrategy.
  try {
    const sale = (await readContract(client, {
      address: ZORA_FIXED_PRICE_STRATEGY,
      abi: FPSS_SALE_ABI,
      functionName: 'sale',
      args: [collection, tokenId],
    })) as { saleStart: bigint; saleEnd: bigint; pricePerToken: bigint }
    if (sale.saleEnd !== 0n) {
      return {
        pricePerToken: sale.pricePerToken,
        currency: 'eth',
        saleStart: sale.saleStart,
        saleEnd: sale.saleEnd,
      }
    }
  } catch {
    // Fall through to the USDC strategy.
  }
  // USDC — ERC20Minter. Only USDC currency is supported (matches the direct
  // collect + collect-all paths); any other ERC20 falls through to null.
  try {
    const sale = (await readContract(client, {
      address: ZORA_ERC20_MINTER,
      abi: ERC20_MINTER_SALE_ABI,
      functionName: 'sale',
      args: [collection, tokenId],
    })) as { saleStart: bigint; saleEnd: bigint; pricePerToken: bigint; currency?: Address }
    if (sale.saleEnd !== 0n && sale.currency?.toLowerCase() === USDC_BASE.toLowerCase()) {
      return {
        pricePerToken: sale.pricePerToken,
        currency: 'usdc',
        saleStart: sale.saleStart,
        saleEnd: sale.saleEnd,
      }
    }
  } catch {
    // Fall through to null.
  }
  return null
}

// A saleConfig synthesized from chain, in the shape both display paths consume.
// saleStart/saleEnd are required (MomentDetail.saleConfig demands them) and now
// carry the REAL on-chain window: resolveOnchainSale returns a sale whenever its
// row is set (saleEnd !== 0), which includes scheduled drops that haven't opened
// yet — so the not-started / ended gates in MomentCard + MomentDetailView must
// see the true saleStart, not a hardcoded "0" that would read as already-active
// and wrongly enable collect before the drop opens. Assignable to
// MomentSaleConfig (its saleStart/End are optional) too, so one helper serves
// /api/moments, /api/moment, and fetchMomentDetail without copying the synth logic.
export interface OnchainSaleConfig {
  type: 'fixedPrice' | 'erc20Mint'
  pricePerToken: string
  saleStart: string
  saleEnd: string
  currency?: string
}

/**
 * Display-price fallback: read the live on-chain sale and shape it as a
 * saleConfig, for moments the inprocess feed omits (writing moments / fresh
 * mints during an indexer gap). The single authoritative source the collect
 * action already reads — applied to the display so the badge isn't blank while
 * the sale is live. Returns null when there's no readable on-chain sale.
 */
export async function onchainSaleConfigFallback(
  client: AnyClient,
  collection: Address,
  tokenId: bigint,
): Promise<OnchainSaleConfig | null> {
  const sale = await resolveOnchainSale(client, collection, tokenId).catch(() => null)
  if (!sale) return null
  return {
    type: sale.currency === 'usdc' ? 'erc20Mint' : 'fixedPrice',
    pricePerToken: sale.pricePerToken.toString(),
    saleStart: sale.saleStart.toString(),
    saleEnd: sale.saleEnd.toString(),
    ...(sale.currency === 'usdc' ? { currency: USDC_BASE } : {}),
  }
}

/**
 * Batched display-price read — the multicall analog of
 * onchainSaleConfigFallback for a whole feed page. Reads BOTH strategies'
 * sale() for every (collection, tokenId) in ONE Multicall3 aggregate, so N
 * gaps cost ONE eth_call instead of the up-to-2N sequential readContract round
 * trips the per-token `gaps.map(onchainSaleConfigFallback)` did. That is the
 * whole point on a rate-limited RPC: /api/moments' Phase-2 fallback can price
 * an entire batch's gaps without the "over rate limit" storm the sequential
 * fan-out caused (and it relieves the other on-chain paths sharing that limit).
 *
 * Semantics match resolveOnchainSale EXACTLY, just batched: a row counts when
 * saleEnd !== 0 (so scheduled-but-not-open drops still carry their real
 * saleStart to the UI's not-started gate), ETH (FixedPriceSaleStrategy) takes
 * precedence over USDC, and only USDC-denominated ERC20 sales resolve.
 * allowFailure isolates one reverting/unset row (no sale, non-Zora contract)
 * to a null for that id — identical to the per-token catch — and a whole-
 * multicall failure (RPC down/throttled) degrades every id to "no on-chain
 * price", leaving callers with whatever Phase 1 gave them.
 *
 * Keyed `collection.toLowerCase():tokenId` (decimal string) so a caller looks
 * up by its own id form.
 */
export async function resolveOnchainSalesBatch(
  client: AnyClient,
  items: { collection: Address; tokenId: bigint }[],
): Promise<Map<string, OnchainSaleConfig>> {
  if (items.length === 0) return new Map()
  // Un-annotated so viem infers the per-contract result union from `contracts`
  // (an explicit Awaited<ReturnType<typeof multicall>> erases that to `{}`);
  // the catch returns, so `res` is definitely assigned past the try. Mirrors
  // fetchEligibleTokens above.
  let res
  try {
    res = await multicall(client, {
      // Even slot = ETH strategy, odd slot = USDC strategy, per item.
      contracts: items.flatMap((it) => [
        {
          address: ZORA_FIXED_PRICE_STRATEGY,
          abi: FPSS_SALE_ABI,
          functionName: 'sale' as const,
          args: [it.collection, it.tokenId] as const,
        },
        {
          address: ZORA_ERC20_MINTER,
          abi: ERC20_MINTER_SALE_ABI,
          functionName: 'sale' as const,
          args: [it.collection, it.tokenId] as const,
        },
      ]),
      allowFailure: true,
    })
  } catch {
    return new Map()
  }
  return saleConfigsFromMulticall(res, items)
}

/** One multicall slot: viem's allowFailure result shape, loosely typed so the
 *  pure resolver below is testable with synthetic rows (no RPC). */
export type SaleReadSlot =
  | { status: 'success'; result: unknown }
  | { status: 'failure'; error?: unknown }

/**
 * Pure resolution half of resolveOnchainSalesBatch (network half above) —
 * turns the flat multicall result array (even slot = ETH sale, odd = USDC
 * sale, per item) into the id → OnchainSaleConfig map. Split out on the same
 * principle as rangeContract's pure math so scripts/verify-moments-batch.ts
 * can pin the ETH-precedence, USDC-currency, saleEnd==0, and failure-isolation
 * rules deterministically. Semantics mirror resolveOnchainSale exactly.
 */
export function saleConfigsFromMulticall(
  res: readonly SaleReadSlot[],
  items: { collection: Address; tokenId: bigint }[],
): Map<string, OnchainSaleConfig> {
  const out = new Map<string, OnchainSaleConfig>()
  for (let i = 0; i < items.length; i++) {
    const key = `${items[i].collection.toLowerCase()}:${items[i].tokenId.toString()}`
    const ethRes = res[2 * i]
    const usdcRes = res[2 * i + 1]
    // ETH — FixedPriceSaleStrategy takes precedence (matches resolveOnchainSale).
    if (ethRes?.status === 'success' && ethRes.result) {
      const sale = ethRes.result as { saleStart: bigint; saleEnd: bigint; pricePerToken: bigint }
      if (sale.saleEnd !== 0n) {
        out.set(key, {
          type: 'fixedPrice',
          pricePerToken: sale.pricePerToken.toString(),
          saleStart: sale.saleStart.toString(),
          saleEnd: sale.saleEnd.toString(),
        })
        continue
      }
    }
    // USDC — ERC20Minter, only when the sale's currency is USDC.
    if (usdcRes?.status === 'success' && usdcRes.result) {
      const sale = usdcRes.result as {
        saleStart: bigint
        saleEnd: bigint
        pricePerToken: bigint
        currency?: Address
      }
      if (sale.saleEnd !== 0n && sale.currency?.toLowerCase() === USDC_BASE.toLowerCase()) {
        out.set(key, {
          type: 'erc20Mint',
          pricePerToken: sale.pricePerToken.toString(),
          saleStart: sale.saleStart.toString(),
          saleEnd: sale.saleEnd.toString(),
          currency: USDC_BASE,
        })
      }
    }
  }
  return out
}

/** One getTokenInfo multicall slot — viem's allowFailure result shape, loosely
 *  typed so the pure resolver below is testable with synthetic rows (no RPC). */
export type TokenInfoSlot =
  | { status: 'success'; result: unknown }
  | { status: 'failure'; error?: unknown }

/**
 * Pure half of resolveSoldOutKeys (network half below) — turns a getTokenInfo
 * multicall result array (one slot per item, SAME order) into the SET of
 * SOLD-OUT keys (`collection:tokenId`, tokenId decimal). A key is sold out only
 * when its edition is CAPPED (not an open edition, per isOpenEdition) AND
 * totalMinted has reached maxSupply — the exact rule MomentCard's `mintedOut`
 * uses, so the feed filter and the card badge can't disagree.
 *
 * Everything else is treated as NOT sold out: open editions, unset / reverting
 * rows (non-Zora-1155 contracts, older versions without getTokenInfo), and
 * malformed results. This fail-OPEN bias is deliberate — the ending-soon filter
 * must never hide a genuinely live drop on a bad read, and a sold-out edition
 * that slips through still renders its own "sold out" button. Split out so
 * scripts/verify-moments-batch.ts can pin the cap/exhaustion rules with no RPC.
 */
export function soldOutKeysFromMulticall(
  res: readonly TokenInfoSlot[],
  items: { collection: Address; tokenId: bigint }[],
): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i < items.length; i++) {
    const r = res[i]
    if (r?.status !== 'success' || !r.result) continue
    const info = r.result as { maxSupply?: bigint; totalMinted?: bigint }
    if (typeof info.maxSupply !== 'bigint' || typeof info.totalMinted !== 'bigint') continue
    if (isOpenEdition(info.maxSupply)) continue
    if (info.totalMinted >= info.maxSupply) {
      out.add(`${items[i].collection.toLowerCase()}:${items[i].tokenId.toString()}`)
    }
  }
  return out
}

/**
 * Read on-chain supply for a batch and return the SOLD-OUT subset as a set of
 * `collection:tokenId` keys. ONE Multicall3 getTokenInfo aggregate for the
 * whole batch (N tokens = one eth_call).
 *
 * Used by the ending-soon feed to drop capped editions whose supply is
 * exhausted: the sale-end index tracks only the sale WINDOW (real close date +
 * started), so a limited edition that minted out while its window is still open
 * lingers there with nothing left to collect. Whole-multicall failure → empty
 * set (fail-open: serve the feed unfiltered rather than empty on an RPC blip);
 * per-row rules — including per-row failure isolation — live in
 * soldOutKeysFromMulticall.
 */
export async function resolveSoldOutKeys(
  client: AnyClient,
  items: { collection: Address; tokenId: bigint }[],
): Promise<Set<string>> {
  if (items.length === 0) return new Set()
  let res
  try {
    res = await multicall(client, {
      contracts: items.map((it) => ({
        address: it.collection,
        abi: ZORA_1155_TOKEN_INFO_ABI,
        functionName: 'getTokenInfo' as const,
        args: [it.tokenId] as const,
      })),
      allowFailure: true,
    })
  } catch {
    return new Set()
  }
  return soldOutKeysFromMulticall(res, items)
}
