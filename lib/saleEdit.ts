import type { Address, Chain, Client, Transport } from 'viem'
import { encodeFunctionData, type Hex } from 'viem'
import { multicall } from 'viem/actions'
import {
  USDC_BASE,
  ZORA_ERC20_MINTER,
  ZORA_FIXED_PRICE_STRATEGY,
} from './zoraMint'
import {
  FPSS_SALE_ABI,
  ERC20_MINTER_SALE_ABI,
  type OnchainSaleConfig,
  type SaleReadSlot,
} from './saleConfig'
import { OPEN_ENDED_SALE_SENTINEL } from './inprocess'

// ───────────────────────────────────────────────────────────────────────────
// Sale-window editing core — the pure half of the "edit sale" feature.
//
// A moment's sale lives on one of two Zora minter strategies (FPSS for ETH,
// ERC20Minter for USDC), and editing it is a `setSale` routed through the
// collection's `callSale` (the strategies only accept the token contract as
// caller). Zora gates `callSale` with onlyAdminOrRole(tokenId, SALES), so the
// creator (defaultAdmin) signs it directly from their own wallet — the same
// direct-write model as useUpdateCollectionMetadata / useAirdrop, chosen over
// the inprocess relay because the relay's operator wallet lacks ADMIN on
// auto-deployed collections (see those hooks' histories) and because
// inprocess's POST /moment/sale takes saleEnd as a JSON number, which cannot
// carry the max-uint64 open-ended sentinel exactly.
//
// setSale REPLACES the whole struct, so an edit must read the full current
// row first and carry every field it doesn't change. Getting that wrong is a
// money bug, not a display bug: `fundsRecipient` is the 0xSplits SplitWallet
// on split moments (clobbering it redirects revenue) and `currency` is what
// keeps a USDC sale a USDC sale. resolveEditedWindow / buildSaleUpdateCall
// below are pure so scripts/verify-sale-edit.ts can pin exactly that.
// ───────────────────────────────────────────────────────────────────────────

// Full on-chain sale row — every field `setSale` writes, plus which strategy
// holds it. Superset of what resolveOnchainSale (display path) surfaces.
export interface FullOnchainSale {
  type: 'fixedPrice' | 'erc20Mint'
  strategy: Address
  saleStart: bigint
  saleEnd: bigint
  maxTokensPerAddress: bigint
  pricePerToken: bigint
  fundsRecipient: Address
  /** Set iff type === 'erc20Mint' (the ERC20Minter struct's trailing field). */
  currency?: Address
}

type AnyClient = Client<Transport, Chain | undefined>

/**
 * Pure discrimination half of readFullOnchainSale — turns the two-slot
 * multicall result (slot 0 = FPSS sale, slot 1 = ERC20Minter sale) into the
 * full row being edited, or null when neither strategy has one. The rules
 * mirror resolveOnchainSale / saleConfigsFromMulticall EXACTLY (a row exists
 * iff saleEnd !== 0; ETH takes precedence; only USDC-denominated ERC20 sales
 * resolve), so the editor and the display/collect paths can never disagree
 * about WHICH sale is being edited. Split out so
 * scripts/verify-sale-edit.ts pins that with no RPC.
 */
export function fullSaleFromMulticall(
  res: readonly SaleReadSlot[],
): FullOnchainSale | null {
  const [ethRes, usdcRes] = res
  if (ethRes?.status === 'success' && ethRes.result) {
    const s = ethRes.result as {
      saleStart: bigint
      saleEnd: bigint
      maxTokensPerAddress: bigint
      pricePerToken: bigint
      fundsRecipient: Address
    }
    if (s.saleEnd !== 0n) {
      return {
        type: 'fixedPrice',
        strategy: ZORA_FIXED_PRICE_STRATEGY,
        saleStart: s.saleStart,
        saleEnd: s.saleEnd,
        maxTokensPerAddress: s.maxTokensPerAddress,
        pricePerToken: s.pricePerToken,
        fundsRecipient: s.fundsRecipient,
      }
    }
  }
  if (usdcRes?.status === 'success' && usdcRes.result) {
    const s = usdcRes.result as {
      saleStart: bigint
      saleEnd: bigint
      maxTokensPerAddress: bigint
      pricePerToken: bigint
      fundsRecipient: Address
      currency?: Address
    }
    if (s.saleEnd !== 0n && s.currency?.toLowerCase() === USDC_BASE.toLowerCase()) {
      return {
        type: 'erc20Mint',
        strategy: ZORA_ERC20_MINTER,
        saleStart: s.saleStart,
        saleEnd: s.saleEnd,
        maxTokensPerAddress: s.maxTokensPerAddress,
        pricePerToken: s.pricePerToken,
        fundsRecipient: s.fundsRecipient,
        currency: s.currency,
      }
    }
  }
  return null
}

/**
 * Read the moment's ACTIVE sale row in full — both strategies in one
 * multicall, resolved through fullSaleFromMulticall above. Returns null when
 * neither strategy has a row (nothing to edit — the UI hides the affordance)
 * or the read fails.
 */
export async function readFullOnchainSale(
  client: AnyClient,
  collection: Address,
  tokenId: bigint,
): Promise<FullOnchainSale | null> {
  let res
  try {
    res = await multicall(client, {
      contracts: [
        {
          address: ZORA_FIXED_PRICE_STRATEGY,
          abi: FPSS_SALE_ABI,
          functionName: 'sale' as const,
          args: [collection, tokenId] as const,
        },
        {
          address: ZORA_ERC20_MINTER,
          abi: ERC20_MINTER_SALE_ABI,
          functionName: 'sale' as const,
          args: [collection, tokenId] as const,
        },
      ],
      allowFailure: true,
    })
  } catch {
    return null
  }
  return fullSaleFromMulticall(res)
}

/**
 * One edited window field. Tri-state, not nullable-number, because the picker
 * prefill is minute-granular while chain values are second-granular: an
 * UNTOUCHED prefilled field must mean "keep the current value exactly" — a
 * parse-back of the prefill would differ by the dropped seconds and burn a
 * pointless wallet prompt on a no-op edit.
 *  - 'keep'  — field untouched → carry the current on-chain value verbatim.
 *  - 'clear' — field emptied   → the field's open semantics (start: "open
 *              now", end: "never expires").
 *  - 'set'   — a picked instant, in unix seconds.
 */
export type WindowFieldEdit =
  | { kind: 'keep' }
  | { kind: 'clear' }
  | { kind: 'set'; sec: number }

export type ResolvedWindow =
  | { ok: true; saleStart: bigint; saleEnd: bigint; changed: boolean }
  | { ok: false; error: string }

/**
 * Turn the editor's two field edits into the window to write — THE semantics
 * of the edit form, kept pure so scripts/verify-sale-edit.ts pins them:
 *
 *  - Clearing the start of a SCHEDULED sale (current start still in the
 *    future) means "open now" → 0, the same clock-skew-safe opens-now the
 *    mint form writes (a wall-clock `now` could land past chain time and
 *    gate the very next block). Clearing an already-open start keeps it —
 *    it is already "open", and rewriting history into a different (if
 *    equivalent) value is a pointless diff.
 *  - A PICKED start at or before now also normalizes to 0 (it means "open
 *    now", and 0 is the canonical spelling of that).
 *  - Clearing the end = "never expires" → the max-uint64 sentinel (shared
 *    with the mint form via OPEN_ENDED_SALE_SENTINEL; on-chain uint64 can't
 *    exceed it, so open-ended round-trips exactly).
 *  - A PICKED end must be in the future (the "end sale now" action is a
 *    separate explicit path — see resolveEndNow — so a mispicked past date
 *    can't silently kill a live sale) and after the resolved start.
 *  - `changed: false` when the resolved window equals the current one, so
 *    the caller skips the wallet prompt entirely (useGrantPermission's
 *    "already" contract).
 *
 * Deliberately NO minimum-window rule here: MintForm's 10-minute floor
 * protects the setup-time self-mint that rides the create transaction, and
 * no such mint rides an edit.
 */
export function resolveEditedWindow(
  current: { saleStart: bigint; saleEnd: bigint },
  input: { start: WindowFieldEdit; end: WindowFieldEdit },
  nowSec: number,
): ResolvedWindow {
  if (input.start.kind === 'set' && !Number.isInteger(input.start.sec)) {
    return { ok: false, error: 'Invalid sale start' }
  }
  if (input.end.kind === 'set' && !Number.isInteger(input.end.sec)) {
    return { ok: false, error: 'Invalid sale end' }
  }

  let saleStart: bigint
  if (input.start.kind === 'keep') {
    saleStart = current.saleStart
  } else if (input.start.kind === 'clear') {
    saleStart = current.saleStart > BigInt(nowSec) ? 0n : current.saleStart
  } else {
    saleStart = input.start.sec <= nowSec ? 0n : BigInt(input.start.sec)
  }

  let saleEnd: bigint
  if (input.end.kind === 'keep') {
    saleEnd = current.saleEnd
  } else if (input.end.kind === 'clear') {
    saleEnd = OPEN_ENDED_SALE_SENTINEL
  } else {
    if (input.end.sec <= nowSec) {
      return { ok: false, error: 'Sale end must be in the future — use "end sale now" to close it' }
    }
    saleEnd = BigInt(input.end.sec)
  }

  if (saleEnd < OPEN_ENDED_SALE_SENTINEL && saleEnd <= saleStart) {
    return { ok: false, error: 'Sale must close after it opens' }
  }

  return {
    ok: true,
    saleStart,
    saleEnd,
    changed: saleStart !== current.saleStart || saleEnd !== current.saleEnd,
  }
}

/**
 * The explicit "end the sale now" action: close the window at `nowSec`. A
 * still-scheduled start is zeroed alongside — leaving a future start behind a
 * past end would write a window that "ended before it opened"; [0, now] reads
 * as a plain ended sale on every surface instead. Always `changed` (the sale
 * row exists ⇒ its current end is nonzero and, being live or scheduled when
 * the button shows, in the future).
 */
export function resolveEndNow(
  current: { saleStart: bigint; saleEnd: bigint },
  nowSec: number,
): { saleStart: bigint; saleEnd: bigint } {
  return {
    saleStart: current.saleStart > BigInt(nowSec) ? 0n : current.saleStart,
    saleEnd: BigInt(nowSec),
  }
}

// setSale WRITE fragments. Tuple field order matches each strategy's stored
// struct exactly as its `sale()` getter returns it (FPSS_SALE_ABI /
// ERC20_MINTER_SALE_ABI above) — same struct, read and write sides. FPSS
// prices are uint96, ERC20Minter's uint256 with a trailing currency.
const FPSS_SET_SALE_ABI = [
  {
    name: 'setSale',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      {
        name: 'salesConfig',
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
    outputs: [],
  },
] as const

const ERC20_MINTER_SET_SALE_ABI = [
  {
    name: 'setSale',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      {
        name: 'salesConfig',
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
    outputs: [],
  },
] as const

/**
 * Encode the strategy-side `setSale` for the current sale with a new window,
 * carrying price / per-address cap / fundsRecipient / currency through
 * UNCHANGED. Returns the strategy address + calldata for the collection's
 * `callSale(tokenId, strategy, data)`. Pure — pinned by
 * scripts/verify-sale-edit.ts. Throws on an ERC20 row with no currency: that
 * means the read was inconsistent, and encoding a zero currency would brick
 * the sale (ERC20Minter rejects zero-currency configs).
 */
export function buildSaleUpdateCall(
  tokenId: bigint,
  sale: FullOnchainSale,
  window: { saleStart: bigint; saleEnd: bigint },
): { strategy: Address; setSaleData: Hex } {
  if (sale.type === 'erc20Mint') {
    if (!sale.currency) throw new Error('ERC20 sale row missing currency')
    return {
      strategy: sale.strategy,
      setSaleData: encodeFunctionData({
        abi: ERC20_MINTER_SET_SALE_ABI,
        functionName: 'setSale',
        args: [
          tokenId,
          {
            saleStart: window.saleStart,
            saleEnd: window.saleEnd,
            maxTokensPerAddress: sale.maxTokensPerAddress,
            pricePerToken: sale.pricePerToken,
            fundsRecipient: sale.fundsRecipient,
            currency: sale.currency,
          },
        ],
      }),
    }
  }
  return {
    strategy: sale.strategy,
    setSaleData: encodeFunctionData({
      abi: FPSS_SET_SALE_ABI,
      functionName: 'setSale',
      args: [
        tokenId,
        {
          saleStart: window.saleStart,
          saleEnd: window.saleEnd,
          maxTokensPerAddress: sale.maxTokensPerAddress,
          pricePerToken: sale.pricePerToken,
          fundsRecipient: sale.fundsRecipient,
        },
      ],
    }),
  }
}

/**
 * Shape a (sale row, window) pair as the saleConfig the display paths consume
 * — for the optimistic detail update after the edit tx confirms, so the page
 * reflects the new window without waiting on any indexer. Identical field
 * semantics to onchainSaleConfigFallback (lib/saleConfig).
 */
export function saleToDisplayConfig(
  sale: FullOnchainSale,
  window: { saleStart: bigint; saleEnd: bigint },
): OnchainSaleConfig {
  return {
    type: sale.type,
    pricePerToken: sale.pricePerToken.toString(),
    saleStart: window.saleStart.toString(),
    saleEnd: window.saleEnd.toString(),
    ...(sale.type === 'erc20Mint' && sale.currency ? { currency: sale.currency } : {}),
  }
}
