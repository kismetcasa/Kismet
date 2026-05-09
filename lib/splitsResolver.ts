import {
  decodeFunctionData,
  parseAbi,
  zeroAddress,
  type AbiEvent,
  type Address,
  type Hex,
} from 'viem'
import type { SplitRecipient } from './splits'

// Structural client type — viem's `PublicClient<Transport, Chain>` from
// serverBaseClient carries Base-specific tx variants that don't unify
// with the default. Same pattern as PublicClientLike in lib/permissions.ts.
type ResolverClient = {
  readContract: (args: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args?: readonly unknown[]
  }) => Promise<unknown>
  getLogs: (args: {
    address: Address
    event: AbiEvent
    args?: { split?: Address }
    fromBlock?: bigint | 'earliest'
    toBlock?: bigint | 'latest'
  }) => Promise<readonly { transactionHash: Hex | null }[]>
  getTransaction: (args: { hash: Hex }) => Promise<{ input: Hex }>
}

// 0xSplits v1 SplitMain — same address on every chain v1 was deployed
// on (Base included). Used as a last-resort if the dynamic splitMain()
// read below fails for transport reasons. Sourced from splits-sdk.
const SPLITMAIN_FALLBACK: Address = '0x2ed6c4B5dA6378c7897AC67Ba9e43102Feb694EE'

const SPLIT_WALLET_ABI = parseAbi([
  'function splitMain() view returns (address)',
])

const CREATE_SPLIT_EVENT = parseAbi([
  'event CreateSplit(address indexed split)',
])[0]

const SPLITMAIN_ABI = parseAbi([
  'function createSplit(address[] accounts, uint32[] percentAllocations, uint32 distributorFee, address controller) returns (address)',
])

// SplitMain stores percentages with 1e6 scale (100% = 1_000_000); our
// SplitRecipient stores the integer 1-100. Round to absorb sub-percent
// precision created outside our flow.
const PERCENTAGE_SCALE = 1_000_000

/**
 * Recovers the recipient list for a 0xSplits v1 SplitWallet by filtering
 * SplitMain CreateSplit logs to the indexed split address, reading the
 * originating tx, and decoding the calldata. Returns null when the
 * split's deployment tx didn't expose `createSplit` at the top level
 * (e.g. wrapped in a 4337 UserOp / multicall), when the address is a v2
 * PullSplit, or on any RPC failure — admin backfill is the fallback.
 */
export async function resolveSplitRecipientsOnChain(
  client: ResolverClient,
  splitAddress: Address,
): Promise<SplitRecipient[] | null> {
  if (!splitAddress || splitAddress.toLowerCase() === zeroAddress) return null

  // v1 SplitWallets expose `splitMain()` pointing back to their factory,
  // so we discover SplitMain dynamically rather than hardcoding it.
  const dynamicSplitMain = (await client
    .readContract({
      address: splitAddress,
      abi: SPLIT_WALLET_ABI,
      functionName: 'splitMain',
    })
    .catch(() => null)) as Address | null
  const splitMain: Address =
    dynamicSplitMain && dynamicSplitMain.toLowerCase() !== zeroAddress
      ? dynamicSplitMain
      : SPLITMAIN_FALLBACK

  let logs: readonly { transactionHash: Hex | null }[] = []
  try {
    logs = await client.getLogs({
      address: splitMain,
      event: CREATE_SPLIT_EVENT,
      args: { split: splitAddress },
      fromBlock: 0n,
      toBlock: 'latest',
    })
  } catch {
    return null
  }
  const txHash = logs[0]?.transactionHash
  if (!txHash) return null

  const tx = await client.getTransaction({ hash: txHash }).catch(() => null)
  if (!tx?.input) return null

  let decoded: ReturnType<typeof decodeFunctionData<typeof SPLITMAIN_ABI>>
  try {
    decoded = decodeFunctionData({ abi: SPLITMAIN_ABI, data: tx.input })
  } catch {
    return null
  }
  if (decoded.functionName !== 'createSplit') return null

  const [accounts, percentAllocations] = decoded.args
  if (
    !accounts ||
    !percentAllocations ||
    accounts.length !== percentAllocations.length ||
    accounts.length < 2
  ) {
    return null
  }

  return accounts.map((address, i) => ({
    address: address.toLowerCase(),
    percentAllocation: Math.round((Number(percentAllocations[i]) / PERCENTAGE_SCALE) * 100),
  }))
}
