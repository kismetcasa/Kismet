// Shared helpers + CANONICAL constants for the agent calldata verifiers.
//
// The treasury-critical values (referral, ERC20Minter, FixedPrice strategy, USDC)
// and the ERC-8021 builder suffix are imported from the SAME production modules
// the routes use — NOT hand-copied — so a change there can't silently pass these
// oracles (the hand-copied duplicate was exactly what could drift). Run via
// `node --experimental-strip-types`: lib/zoraMint.ts and lib/builderCode.ts are
// viem-only, so node loads them directly. lib/seaport.ts can NOT be loaded this
// way (it relative-imports './zoraMint' without an extension, which node's type
// stripping won't resolve), so the PUBLIC Seaport 1.5 address/ABI/domain stay
// declared in the buy/list verifiers — those are public protocol constants, not
// Kismet treasury values.

import { concat, getAddress, parseAbi, type Hex } from 'viem'
import {
  KISMET_REFERRAL,
  USDC_BASE,
  ZORA_ERC20_MINTER,
  ZORA_FIXED_PRICE_STRATEGY,
} from '../lib/zoraMint.ts'
import { BUILDER_DATA_SUFFIX } from '../lib/builderCode.ts'
import {
  PLATFORM_FEE_RECIPIENT as _PLATFORM_FEE_RECIPIENT,
  computePlatformFee as _computePlatformFee,
  isBelowListingFloor as _isBelowListingFloor,
  MIN_LISTING_PRICE_BASE_UNITS as _MIN_LISTING_PRICE_BASE_UNITS,
} from '../lib/platformFee.ts'

// Canonical, production-sourced (aliased to the short names the verifiers use).
export const FPSS = ZORA_FIXED_PRICE_STRATEGY
export const ERC20_MINTER = ZORA_ERC20_MINTER
export const USDC = USDC_BASE
export const REFERRAL = KISMET_REFERRAL
export const PLATFORM_FEE_RECIPIENT = _PLATFORM_FEE_RECIPIENT
export const computePlatformFee = _computePlatformFee
export const isBelowListingFloor = _isBelowListingFloor
export const MIN_LISTING_PRICE_BASE_UNITS = _MIN_LISTING_PRICE_BASE_UNITS
// BUILDER_DATA_SUFFIX is `Hex | undefined` (env-gated in production); the
// verifiers require it, so fail loud if it's somehow unset.
const suffix = BUILDER_DATA_SUFFIX
if (!suffix) throw new Error('BUILDER_DATA_SUFFIX is undefined — check lib/builderCode.ts / NEXT_PUBLIC_BUILDER_CODE')
export const builderSuffix: Hex = suffix

// Public, non-treasury constants (safe to declare here).
export const SEAPORT = '0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC' as `0x${string}`
export const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as `0x${string}`
export const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`
// The published ERC-8021 suffix bytes the source BUILDER_DATA_SUFFIX must equal.
export const PUBLISHED_SUFFIX = '0x62635f70383736776231630b0080218021802180218021802180218021'

export const ERC20_ABI = parseAbi(['function approve(address spender, uint256 value) returns (bool)'])
export const MINT_1155_ABI = parseAbi([
  'function mint(address minter, uint256 tokenId, uint256 quantity, address[] rewardsRecipients, bytes minterArguments) payable',
])
export const ERC20_MINTER_ABI = parseAbi([
  'function mint(address mintTo, uint256 quantity, address tokenAddress, uint256 tokenId, uint256 totalValue, address currency, address mintReferral, string comment)',
])

export const withSuffix = (data: Hex): Hex => concat([data, builderSuffix])
export const selector = (data: string): string => data.slice(0, 10)
export const eq = (a: string, b: string): boolean => getAddress(a) === getAddress(b)

// Each verifier runs as its own process, so this module-level counter is
// per-verifier; `report` exits with the right code at the end.
let failures = 0
export const check = (name: string, cond: boolean, detail: unknown = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${String(detail)}` : ''}`)
    failures++
  }
}
export const report = (okMessage: string): never => {
  console.log(`\n${failures === 0 ? okMessage : `FAILED — ${failures} assertion(s)`}`)
  process.exit(failures === 0 ? 0 : 1)
}
