import type { Address, Chain, Client, Transport } from 'viem'
import { multicall } from 'viem/actions'
import { USDC_BASE, ZORA_ERC20_MINTER, ZORA_FIXED_PRICE_STRATEGY } from './zoraMint'

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

// ZoraCreator1155Impl.getTokenInfo(tokenId) — used to filter out tokens whose
// totalMinted has hit maxSupply (mint() would revert). maxSupply === 0 is
// Zora's convention for "unlimited".
const ZORA_TOKEN_INFO_ABI = [
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

export interface EligibleToken {
  tokenId: bigint
  pricePerToken: bigint
  maxPerAddress: bigint
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
 * maxPerAddress — those would revert a multicall batch. Returns [] on any
 * read failure so callers stay simple and a USDC RPC blip can't crash the
 * ETH leg in mixed flows.
 *
 * Two RPC round trips: one multicall for sale configs + token info, one
 * for balances. Fail-closed on balance reads so a single revert can't
 * cascade an atomic EIP-5792 bundle.
 */
export async function fetchEligibleTokens(
  client: AnyClient,
  collection: Address,
  tokenIds: bigint[],
  currency: SaleCurrency,
  account?: Address,
): Promise<EligibleToken[]> {
  if (tokenIds.length === 0) return []

  const now = BigInt(Math.floor(Date.now() / 1000))
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
          abi: ZORA_TOKEN_INFO_ABI,
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
    // the mint will revert at submit time as a fallback.
    if (infoRes.status === 'success' && infoRes.result) {
      const info = infoRes.result as { maxSupply: bigint; totalMinted: bigint }
      if (info.maxSupply > 0n && info.totalMinted >= info.maxSupply) continue
    }

    candidates.push({
      tokenId: tokenIds[i],
      pricePerToken: sale.pricePerToken,
      maxPerAddress: sale.maxTokensPerAddress,
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

  return candidates.filter((c, i) => {
    const r = balanceResults[i]
    if (r.status !== 'success') return false
    const balance = r.result as bigint
    return !(c.maxPerAddress > 0n && balance >= c.maxPerAddress)
  })
}
