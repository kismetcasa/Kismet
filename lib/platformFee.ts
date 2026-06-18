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
