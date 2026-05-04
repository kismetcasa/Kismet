import { encodeAbiParameters, parseAbi, parseAbiParameters, type Address } from 'viem'

// Zora 1155 protocol — Base mainnet (chainId 8453).
// Verified against @zoralabs/protocol-deployments and the inprocess.world
// protocol SDK (lib/protocolSdk/constants.ts). Inprocess uses these same
// addresses for collections deployed through their factory, so collects
// against any inprocess-deployed token route through the same strategies.
export const ZORA_FIXED_PRICE_STRATEGY: Address = '0x2994762aA0E4C750c51f333C10d81961faEBE785'
export const ZORA_ERC20_MINTER: Address = '0xE27d9Dc88dAB82ACa3ebC49895c663C6a0CfA014'

// Native USDC on Base (Circle).
export const USDC_BASE: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

// Single recipient for ALL Kismet platform rewards: Zora's mint-referral split,
// createReferral on collection deploy, etc. Hardcoded so we can't typo it
// across files. Keep this in sync with createReferral set during deploy.
export const KISMET_REFERRAL: Address = '0x6A0bA3707dF9D13A4445cD7E04274B2725930cD7'

// Zora 1155 mint() (post-v2.0.0 contracts). All inprocess and Kismet deploys
// from the last ~year are new-style; legacy mintWithRewards() is intentionally
// not supported here.
export const ZORA_1155_MINT_ABI = parseAbi([
  'function mint(address minter, uint256 tokenId, uint256 quantity, address[] rewardsRecipients, bytes minterArguments) payable',
  'function mintFee() view returns (uint256)',
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
