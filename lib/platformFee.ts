import type { Address } from 'viem'

// TREASURY-CRITICAL: this address receives the 1% secondary-market platform fee
// on every Seaport sale. Override per-deployment with NEXT_PUBLIC_PLATFORM_FEE_RECIPIENT
// (ideally a dedicated Gnosis Safe separate from the mint-referral treasury).
// Any change must be reviewed by a treasury signer — a silent address swap
// redirects ALL future secondary-market fee revenue to the new address.
//
// `?.trim() ||` (not `??`) so an EMPTY or whitespace env var falls back to the
// treasury default. `.env.example` ships this key blank; `??` would only catch
// undefined, leaving an empty `NEXT_PUBLIC_PLATFORM_FEE_RECIPIENT=` to resolve
// to '' — which fails isAddress() and 500s every listing (total outage). An
// address is never legitimately empty, so the fallback is always the safe choice.
export const PLATFORM_FEE_RECIPIENT: Address = (
  process.env.NEXT_PUBLIC_PLATFORM_FEE_RECIPIENT?.trim() ||
  '0x099B9BBe0937428e145a3003dDf58e7E0CF69801'
) as Address

// 1% of every secondary-market sale. Hardcoded — changing the rate requires
// a code deploy (no hot-mutable admin surface for a revenue-gating parameter).
// 100 bps / 10,000 = 1%.
export const PLATFORM_FEE_BPS = 100n

// Floor division so sellerProceeds + platformFee + royaltyAmount == price
// exactly (sub-unit dust stays with the seller, never with the fee recipient).
export function computePlatformFee(price: bigint): bigint {
  return (price * PLATFORM_FEE_BPS) / 10_000n
}

// Smallest price (base units) whose 1% fee is at least one base unit. Below it
// computePlatformFee floors to 0, buildSellOrder omits the fee item, and the
// platform earns nothing on the sale. Derived from the rate so it stays correct
// if PLATFORM_FEE_BPS ever changes: (price·BPS)/10000 > 0 ⟺ price ≥ ⌈10000/BPS⌉.
export const MIN_LISTING_PRICE_BASE_UNITS: bigint =
  (10_000n + PLATFORM_FEE_BPS - 1n) / PLATFORM_FEE_BPS

// Single source of truth for the "price too low to list" rule. Shared by the web
// ListButton, the agent prepare-list route, and the /api/listings POST so the
// three can never drift — the drift that previously let a client build + sign an
// order the POST then rejected. Defined via computePlatformFee so it stays in
// lockstep with what buildSellOrder actually encodes (fee item only when fee > 0).
export function isBelowListingFloor(price: bigint): boolean {
  return computePlatformFee(price) === 0n
}

// Single source of truth for the seller's net: the number the proceeds
// PREVIEW shows and the number the SIGNED Seaport order encodes must come
// from the same arithmetic, or a rule change in one silently breaks the
// promise the preview makes. Callers: ListButton's preview effect and its
// handleList order construction.
export function computeSellerProceeds(
  price: bigint,
  royalty: bigint,
): { fee: bigint; proceeds: bigint } {
  const fee = computePlatformFee(price)
  return { fee, proceeds: price - royalty - fee }
}
