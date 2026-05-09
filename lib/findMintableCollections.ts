import type { Address, GetLogsReturnType } from 'viem'
import { PERMISSION_BIT_ADMIN, PERMISSION_BIT_MINTER } from './permissions'

// Structural client type so the helper isn't tied to viem's chain
// generic — serverBaseClient returns a Base client whose OP-Stack
// extensions don't unify with the default PublicClient.
type GetLogsClient = {
  getLogs: (args: {
    address: Address[]
    event: typeof UPDATED_PERMISSIONS_EVENT
    args: { tokenId: bigint; user?: Address }
    fromBlock: 'earliest' | bigint
    toBlock: 'latest' | bigint
  }) => Promise<GetLogsReturnType<typeof UPDATED_PERMISSIONS_EVENT>>
}

const UPDATED_PERMISSIONS_EVENT = {
  type: 'event',
  name: 'UpdatedPermissions',
  inputs: [
    { name: 'tokenId', type: 'uint256', indexed: true },
    { name: 'user', type: 'address', indexed: true },
    { name: 'permissions', type: 'uint256', indexed: true },
  ],
  anonymous: false,
} as const

/**
 * Returns the subset of `candidates` where `viewer` holds at least one
 * bit in `mask` at tokenId 0 (collection-wide). One `getLogs` across
 * every candidate, topic-filtered by `tokenId=0` and `user=viewer`;
 * latest event per collection wins (each addPermission / removePermission
 * emits the new bitmap). Replaces N per-collection `permissions(0, v)`
 * reads with a single union query.
 */
export async function findMintableCollections(
  client: GetLogsClient,
  candidates: Address[],
  viewer: Address,
  /** Bits the latest perms must intersect to qualify. Default mirrors
   *  Zora's adminMint mask (ADMIN | MINTER). Pass ADMIN alone when
   *  scanning a smart wallet for MintForm picker eligibility. */
  mask: bigint = PERMISSION_BIT_ADMIN | PERMISSION_BIT_MINTER,
): Promise<Address[]> {
  if (candidates.length === 0) return []
  const logs = await client.getLogs({
    address: candidates,
    event: UPDATED_PERMISSIONS_EVENT,
    args: { tokenId: 0n, user: viewer },
    fromBlock: 'earliest',
    toBlock: 'latest',
  })
  // Latest event per collection wins.
  type Latest = { perms: bigint; block: bigint; idx: number }
  const latest = new Map<string, Latest>()
  for (const log of logs) {
    const addr = log.address.toLowerCase()
    const block = log.blockNumber ?? 0n
    const idx = log.logIndex ?? 0
    const prev = latest.get(addr)
    const isNewer =
      !prev ||
      block > prev.block ||
      (block === prev.block && idx > prev.idx)
    if (!isNewer) continue
    const perms = log.args.permissions as bigint | undefined
    if (perms === undefined) continue
    latest.set(addr, { perms, block, idx })
  }
  const out: Address[] = []
  for (const [addr, { perms }] of latest.entries()) {
    if ((perms & mask) !== 0n) out.push(addr as Address)
  }
  return out
}

/**
 * Inverse of findMintableCollections: one collection, every user.
 * Returns every address holding ADMIN at tokenId 0, derived from the
 * latest UpdatedPermissions event per user. Lets the Authorize-creators
 * panel surface off-platform grants (etherscan, foundry, etc.) that
 * never wrote to our KV reverse-lookup.
 *
 * `exclude` filters out system addresses (the deployer's smart wallet
 * + OPERATOR_SMART_WALLET, both granted at deploy via setupActions) so
 * the returned list is exactly the "intentional" admin set.
 */
export async function findAdminHoldersAtZero(
  client: GetLogsClient,
  collection: Address,
  exclude: Address[] = [],
): Promise<Address[]> {
  const logs = await client.getLogs({
    address: [collection],
    event: UPDATED_PERMISSIONS_EVENT,
    args: { tokenId: 0n },
    fromBlock: 'earliest',
    toBlock: 'latest',
  })
  type Latest = { perms: bigint; block: bigint; idx: number }
  const latest = new Map<string, Latest>()
  for (const log of logs) {
    const user = log.args.user
    if (!user) continue
    const key = user.toLowerCase()
    const block = log.blockNumber ?? 0n
    const idx = log.logIndex ?? 0
    const prev = latest.get(key)
    const isNewer =
      !prev ||
      block > prev.block ||
      (block === prev.block && idx > prev.idx)
    if (!isNewer) continue
    const perms = log.args.permissions as bigint | undefined
    if (perms === undefined) continue
    latest.set(key, { perms, block, idx })
  }
  const excludeSet = new Set(exclude.map((a) => a.toLowerCase()))
  const out: Address[] = []
  for (const [addr, { perms }] of latest.entries()) {
    if (excludeSet.has(addr)) continue
    if ((perms & PERMISSION_BIT_ADMIN) !== 0n) out.push(addr as Address)
  }
  return out
}
