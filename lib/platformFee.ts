import type { Address } from 'viem'

// TREASURY-CRITICAL: this address receives the 1% secondary-market platform fee
// on every Seaport sale. Override per-deployment with NEXT_PUBLIC_PLATFORM_FEE_RECIPIENT
// (ideally a dedicated Gnosis Safe separate from the mint-referral treasury).
// Any change must be reviewed by a treasury signer — a silent address swap
// redirects ALL future secondary-market fee revenue to the new address.
export const PLATFORM_FEE_RECIPIENT: Address = (
  process.env.NEXT_PUBLIC_PLATFORM_FEE_RECIPIENT ??
  '0xc6021D9F09e145a6297f64551aa2eCA6d66F8f75'
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
