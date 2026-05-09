import {
  decodeFunctionData,
  parseAbi,
  type AbiEvent,
  type Address,
  type Hex,
} from 'viem'
import type { SplitRecipient } from './splits'

// Structural type that any viem PublicClient satisfies regardless of its
// chain generic. The `PublicClient<Transport, Chain>` instance returned by
// serverBaseClient() carries Base/OP-Stack tx variants that don't unify
// with viem's default `PublicClient`, so accepting a structural shape is
// the cleanest way to keep this resolver chain-agnostic — same pattern
// as `PublicClientLike` in lib/permissions.ts.
type ResolverClient = {
  getLogs: (args: {
    address: Address
    event: AbiEvent
    args?: { split?: Address }
    fromBlock?: bigint | 'earliest'
    toBlock?: bigint | 'latest'
  }) => Promise<readonly { transactionHash: Hex | null }[]>
  getTransaction: (args: { hash: Hex }) => Promise<{ input: Hex }>
}

// 0xSplits v1 SplitMain on Base. Inprocess deploys split contracts
// through this factory at mint time, so the recipient list lives in
// the calldata of the originating `createSplit` transaction. v2
// (PullSplitFactory + SplitFactory) uses a different deployment shape
// and isn't decoded here — the resolver returns null for those, which
// leaves the moment in the same state as before (admin can backfill
// manually via /api/admin/splits).
const SPLITMAIN_BASE: Address = '0x80f1B766817D04870f115fEBbcCADF8DBF75E017'

const CREATE_SPLIT_EVENT = parseAbi([
  'event CreateSplit(address indexed split)',
])[0]

const SPLITMAIN_ABI = parseAbi([
  'function createSplit(address[] accounts, uint32[] percentAllocations, uint32 distributorFee, address controller) returns (address)',
])

// SplitMain stores percentages as fixed-point with 1e6 scale (100% = 1_000_000).
// Our `SplitRecipient.percentAllocation` is the integer 1-100 the mint flow
// validates; divide by 10_000 to convert. Round to absorb tiny rounding
// drift in case a split was created with non-integer precision upstream.
const PERCENTAGE_SCALE = 1_000_000

/**
 * Recovers the recipient list for a 0xSplits v1 SplitWallet by:
 *   1. Filtering SplitMain `CreateSplit` logs to the indexed split address
 *      (single-log query — split addresses are deterministic, so there's
 *      exactly one `CreateSplit` per split contract).
 *   2. Reading the originating transaction calldata.
 *   3. Decoding against `createSplit(address[], uint32[], uint32, address)`.
 *
 * Returns null on any failure (RPC error, no log found, calldata didn't
 * decode as `createSplit` — e.g. the split was deployed via a contract
 * that wraps SplitMain). Callers should treat null as "couldn't resolve"
 * and fall through to whatever behavior they had before.
 */
export async function resolveSplitRecipientsOnChain(
  client: ResolverClient,
  splitAddress: Address,
): Promise<SplitRecipient[] | null> {
  let logs: readonly { transactionHash: Hex | null }[] = []
  try {
    logs = await client.getLogs({
      address: SPLITMAIN_BASE,
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
