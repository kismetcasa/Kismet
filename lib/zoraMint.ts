import {
  encodeAbiParameters,
  parseAbi,
  parseAbiParameters,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'

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
//
// TREASURY-CRITICAL: this address receives every dollar of platform mint fees.
// A PR that silently changes this constant rotates ALL future revenue to the
// new address. Any change must be reviewed by a treasury signer and verified
// against the on-chain createReferral configuration on existing collections.
const KISMET_REFERRAL: Address = '0xc6021D9F09e145a6297f64551aa2eCA6d66F8f75'

// Zora 1155 mint() (post-v2.0.0 contracts). All inprocess and Kismet deploys
// from the last ~year are new-style; legacy mintWithRewards() is intentionally
// not supported here. totalSupply tracks how many of a given token id have
// been minted (sum of all editions), used to display "X collected" in UIs.
export const ZORA_1155_MINT_ABI = parseAbi([
  'function mint(address minter, uint256 tokenId, uint256 quantity, address[] rewardsRecipients, bytes minterArguments) payable',
  'function mintFee() view returns (uint256)',
  'function totalSupply(uint256 id) view returns (uint256)',
])

// ZoraCreator1155Impl.getTokenInfo(tokenId) — single read returns the token's
// metadata URI, supply cap, and lifetime mint count. We use it for display
// (supply badge + "X collected") and for the minted-out gate. Lifetime
// `totalMinted` is what mint() enforces against `maxSupply` on-chain, so it's
// the authoritative source for both — strictly more correct than totalSupply
// (which decreases on burn) for the cap check.
export const ZORA_1155_TOKEN_INFO_ABI = [
  {
    name: 'getTokenInfo',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'uri', type: 'string' },
          { name: 'maxSupply', type: 'uint256' },
          { name: 'totalMinted', type: 'uint256' },
        ],
      },
    ],
  },
] as const

// Open-edition supply marker. Two equivalent representations exist on-chain:
//   - 0: Zora's protocol convention — mint() skips the cap check entirely.
//   - max uint64: inprocess's SDK explicitly writes this when calling
//     setupNewToken for an open-edition token (our buildCoverTokenSetupActions
//     mirrors that).
// Treat both as "no cap" for display + minted-out logic.
export const OPEN_EDITION_MINT_SIZE = 18446744073709551615n
export function isOpenEdition(maxSupply: bigint): boolean {
  return maxSupply === 0n || maxSupply >= OPEN_EDITION_MINT_SIZE
}

// ERC20Minter — note that mint() lives on the strategy itself, NOT on the 1155
// (unlike the FixedPrice flow). Args are typed parameters, no minterArguments
// bytes blob.
const ZORA_ERC20_MINTER_ABI = parseAbi([
  'function mint(address mintTo, uint256 quantity, address tokenAddress, uint256 tokenId, uint256 totalValue, address currency, address mintReferral, string comment)',
])

export const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
])

// FixedPriceSale's mint() reads (mintTo, comment) out of an abi-encoded blob
// passed as the minterArguments parameter on the 1155 contract.
function encodeFixedPriceMinterArgs(mintTo: Address, comment: string): `0x${string}` {
  return encodeAbiParameters(parseAbiParameters('address, string'), [mintTo, comment ?? ''])
}

// OZ Multicall — every Zora 1155 collection inherits this. Used for batching
// admin operations on a single collection (permission grants, airdrops) into
// one user signature; reverts atomically on any sub-call failure. Note: NOT
// used for collect-all because multicall is `nonpayable` (matches Zora's
// on-chain ABI — declared here to match so a future caller can't accidentally
// attach `value` and get a dispatch revert). For batching value-carrying
// mints see hooks/useCollectAll.ts and its EIP-5792 bundle.
export const ZORA_MULTICALL_ABI = parseAbi([
  'function multicall(bytes[] data) returns (bytes[] results)',
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

// Multicall3 — the canonical universal batcher deployed at the same address
// on every EVM chain (Arachnid CREATE2 deterministic deployment). We use it
// for pure-ETH collect-all batches because aggregate3Value is `payable` and
// passes EACH sub-call its OWN partitioned value — exactly what Zora's
// FixedPriceSaleStrategy needs for its strict ethValueSent equality check.
// Unlike Zora's inherited `multicall(bytes[])` (OZ delegatecall, nonpayable,
// replicates msg.value across sub-calls), Multicall3 uses CALL with explicit
// per-call `{value: val}` syntax — see github.com/mds1/multicall.
//
// Verified canonical on Base via @zoralabs/protocol-sdk's apis/multicall3.ts.
export const MULTICALL3_ADDRESS: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'

// aggregate3Value entry: `[(target, allowFailure, value, callData)[]]` →
// `(success, returnData)[]`. We use `allowFailure: false` so any inner
// revert undoes the whole batch — same all-or-nothing UX as atomic EIP-5792,
// preventing partial-charge surprises.
const MULTICALL3_ABI = parseAbi([
  'struct Call3Value { address target; bool allowFailure; uint256 value; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3Value(Call3Value[] calls) payable returns (Result[] returnData)',
])

/**
 * Build the (abi, functionName, args, value) tuple for a Multicall3
 * `aggregate3Value` batch. Used ONLY for pure-ETH collect-all bundles:
 *
 * USDC batching via Multicall3 would NOT work — the ERC20Minter pulls funds
 * via `safeTransferFrom(msg.sender, …)` and msg.sender of each inner call
 * here is Multicall3, which holds no USDC. The USDC path stays on EIP-5792.
 *
 * Recipient correctness: the user's address must already be encoded in each
 * sub-call's calldata (Zora's `minterArguments` mintTo). msg.sender of the
 * 1155.mint call is Multicall3, but FPSS reads mintTo from minterArguments
 * (verified against ZoraCreatorFixedPriceSaleStrategy.sol L91-94), so the
 * NFT is correctly delivered to the user.
 *
 * The Purchased(sender,…) event will record Multicall3 as `sender`; this
 * is cosmetic — indexers should join on TransferSingle.to for "who collected".
 *
 * value totals are summed; Multicall3 itself asserts msg.value equals the
 * sum at the end of aggregate3Value (its own invariant), so a mismatch here
 * would revert at dispatch.
 */
export function buildMulticall3Batch(calls: readonly { to: Address; data: Hex; value: bigint }[]) {
  return {
    abi: MULTICALL3_ABI,
    functionName: 'aggregate3Value',
    args: [
      calls.map((c) => ({
        target: c.to,
        allowFailure: false,
        value: c.value,
        callData: c.data,
      })),
    ],
    value: calls.reduce((sum, c) => sum + c.value, 0n),
  } as const
}

// Defense-in-depth sanity bound on mintFee(). Zora's protocol-wide mint fee
// has historically been 0.000111 ETH (~$0.30); 0.01 ETH is ~90× headroom but
// catches a misbehaving / mis-upgraded / non-canonical 1155 contract that
// returns a pathological value before the user signs it. Applies to every
// ETH-priced mint path (collect-all, direct-collect) so a single source of
// truth governs the bound.
const MAX_REASONABLE_MINT_FEE_WEI = parseEther('0.01')

/**
 * Read mintFee() from a Zora 1155 collection and assert it's within the
 * sanity bound before returning. Throwing here aborts the caller's try
 * before any value-carrying call is built, so the user never signs a
 * runaway value on a pathological contract.
 */
export async function readMintFeeWithBound(
  client: PublicClient,
  collection: Address,
): Promise<bigint> {
  const mintFee = await client.readContract({
    address: collection,
    abi: ZORA_1155_MINT_ABI,
    functionName: 'mintFee',
  })
  if (mintFee > MAX_REASONABLE_MINT_FEE_WEI) {
    throw new Error('Refusing to mint: protocol mint fee exceeds safety bound')
  }
  return mintFee
}

/**
 * Build the (abi, functionName, args, value) tuple for a Zora 1155
 * ETH-priced mint. The same tuple ends up on-chain whether the caller
 * dispatches via useWriteContract (useDirectCollect's single-mint path)
 * or via encodeFunctionData + EIP-5792 wallet_sendCalls (useCollectAll's
 * bundled path).
 *
 * TREASURY-CRITICAL: this function is the single source of truth for the
 * referral recipient (KISMET_REFERRAL), the strategy address
 * (ZORA_FIXED_PRICE_STRATEGY), and the minterArguments encoding on every
 * ETH-priced mint the platform issues. Inlining the args at a callsite
 * instead of going through this helper is a divergence vector that could
 * silently route one of the two collect flows' mint-referral rewards
 * elsewhere — exactly the bug class the comment on KISMET_REFERRAL above
 * warns about, just from a different attack surface.
 *
 * value = (mintFee + pricePerToken) * quantity, matching Zora protocol-sdk's
 * parseMintCosts.totalCostEth. The strategy's strict equality check rejects
 * any mismatch with WrongValueSent, so a wrong value here can never become
 * an overpay — it would just revert.
 */
export function buildEthMintCall(params: {
  tokenId: bigint
  mintTo: Address
  quantity: bigint
  mintFee: bigint
  pricePerToken: bigint
  comment: string
}) {
  return {
    abi: ZORA_1155_MINT_ABI,
    functionName: 'mint',
    args: [
      ZORA_FIXED_PRICE_STRATEGY,
      params.tokenId,
      params.quantity,
      [KISMET_REFERRAL],
      encodeFixedPriceMinterArgs(params.mintTo, params.comment),
    ],
    value: (params.mintFee + params.pricePerToken) * params.quantity,
  } as const
}

/**
 * Build the (abi, functionName, args) tuple for a USDC-priced mint via
 * the ERC20Minter strategy. Same single-source-of-truth purpose as
 * buildEthMintCall, for the ERC20 leg.
 *
 * Returns no value field — USDC is pulled via transferFrom by the
 * ERC20Minter, so the caller must hold a sufficient USDC allowance on
 * ZORA_ERC20_MINTER before invoking. The strategy itself enforces
 * totalValue === quantity * sale.pricePerToken on-chain.
 *
 * TREASURY-CRITICAL: same warning as buildEthMintCall — this is the only
 * sanctioned way to construct the args, including the hardcoded
 * KISMET_REFERRAL recipient and the USDC_BASE currency.
 */
export function buildUsdcMintCall(params: {
  collection: Address
  tokenId: bigint
  mintTo: Address
  quantity: bigint
  pricePerToken: bigint
  comment: string
}) {
  return {
    abi: ZORA_ERC20_MINTER_ABI,
    functionName: 'mint',
    args: [
      params.mintTo,
      params.quantity,
      params.collection,
      params.tokenId,
      params.pricePerToken * params.quantity,
      USDC_BASE,
      KISMET_REFERRAL,
      params.comment,
    ],
  } as const
}
