import { encodeAbiParameters, parseAbi, parseAbiParameters, type Address } from 'viem'

// Zora 1155 protocol — Base mainnet (chainId 8453).
//
// IMPORTANT: ZORA_FIXED_PRICE_STRATEGY is the FPSS variant inprocess.world's
// collection factory wires onto tokens deployed through their SDK — NOT the
// canonical Zora protocol-deployments FPSS (0x04E2516A2c207E84a1839755675dfd8eF6302F0a,
// see @zoralabs/protocol-deployments). Both are valid Zora-protocol FPSS
// implementations; they're independent deployments. This codebase only
// surfaces inprocess-deployed collections in featured feeds, so this is the
// correct strategy to read sale configs from + pass as `minter` in mint().
//
// If a non-inprocess Zora collection were ever featured, fetchEligibleTokens
// would read this FPSS, get all-zeros (no sale configured here), and silently
// filter the token out of collect-all. Fail-safe (no funds risk), but a
// product gap to track if cross-platform features ship.
//
// ERC20_MINTER below is the canonical Zora ERC20Minter on Base (shared across
// inprocess and Zora-native collections — Zora doesn't fork ERC20Minter the
// way the FPSS deployment splits).
export const ZORA_FIXED_PRICE_STRATEGY: Address = '0x2994762aA0E4C750c51f333C10d81961faEBE785'
export const ZORA_ERC20_MINTER: Address = '0xE27d9Dc88dAB82ACa3ebC49895c663C6a0CfA014'

// Native USDC on Base (Circle).
export const USDC_BASE: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

// Single recipient for ALL Kismet platform rewards: Zora's mint-referral split,
// createReferral on collection deploy, etc. Hardcoded so we can't typo it
// across files. Keep this in sync with createReferral set during deploy.
export const KISMET_REFERRAL: Address = '0xc6021D9F09e145a6297f64551aa2eCA6d66F8f75'

// Zora 1155 mint() (post-v2.0.0 contracts). All inprocess and Kismet deploys
// from the last ~year are new-style; legacy mintWithRewards() is intentionally
// not supported here. totalSupply tracks how many of a given token id have
// been minted (sum of all editions), used to display "X collected" in UIs.
export const ZORA_1155_MINT_ABI = parseAbi([
  'function mint(address minter, uint256 tokenId, uint256 quantity, address[] rewardsRecipients, bytes minterArguments) payable',
  'function mintFee() view returns (uint256)',
  'function totalSupply(uint256 id) view returns (uint256)',
])

// ERC20Minter — note that mint() lives on the strategy itself, NOT on the 1155
// (unlike the FixedPrice flow). Args are typed parameters, no minterArguments
// bytes blob.
export const ZORA_ERC20_MINTER_ABI = parseAbi([
  'function mint(address mintTo, uint256 quantity, address tokenAddress, uint256 tokenId, uint256 totalValue, address currency, address mintReferral, string comment)',
])

export const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
])

// FixedPriceSale's mint() reads (mintTo, comment) out of an abi-encoded blob
// passed as the minterArguments parameter on the 1155 contract.
export function encodeFixedPriceMinterArgs(mintTo: Address, comment: string): `0x${string}` {
  return encodeAbiParameters(parseAbiParameters('address, string'), [mintTo, comment ?? ''])
}

// OZ Multicall — every Zora 1155 collection inherits this. Lets us batch many
// per-token mint() calls into one user signature for "collect all" on a
// featured collection. Reverts atomically on any sub-call failure, so callers
// MUST pre-filter eligibility (see lib/saleConfig.ts).
export const ZORA_MULTICALL_ABI = parseAbi([
  'function multicall(bytes[] data) payable returns (bytes[] results)',
])

// Zora 1155: returns the splits contract address for a token (set as the
// per-token royaltyRecipient when inprocess deploys a splits contract at
// mint time). Used to auto-resolve the split address for distribution.
export const ZORA_CREATOR_REWARD_RECIPIENT_ABI = parseAbi([
  'function getCreatorRewardRecipient(uint256 tokenId) view returns (address)',
])

// Cap on how many mints we'll batch per "collect all" tx. Picked to keep gas
// well under the wallet-preview-readable limit (~5M for 20 × ~250k each on
// Base) so users see the full impact before signing.
export const MAX_COLLECT_ALL_BATCH = 20
