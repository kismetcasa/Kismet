import type { Address, GetLogsReturnType } from 'viem'
import { PERMISSION_BIT_ADMIN, PERMISSION_BIT_MINTER } from './permissions'

// Structural client type — same pattern as PublicClientLike in
// lib/permissions.ts. Avoids tying this helper to viem's chain
// generic, since serverBaseClient returns a Base-typed client whose
// OP-Stack tx extensions don't unify with viem's default PublicClient.
type GetLogsClient = {
  getLogs: (args: {
    address: Address[]
    event: typeof UPDATED_PERMISSIONS_EVENT
    args: { tokenId: bigint; user: Address }
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
 * mint-capable bit (MINTER or ADMIN) at tokenId 0 (collection-wide).
 *
 * Implementation: one `getLogs` call across every candidate, topic-
 * filtered by indexed `tokenId=0` and `user=viewer`. Each addPermission
 * / removePermission emits the user's full new bitmap, so the latest
 * event per collection is authoritative — sort by (blockNumber,
 * logIndex), keep only those with the mint mask set.
 *
 * Why not per-collection `permissions(0, viewer)` reads: that's N
 * RPC calls; this is one. Public RPCs can rate-limit on big address
 * arrays, but our paid Base RPC handles the union fine, and we're
 * naturally bounded by the size of `getTrackedCollections()`.
 *
 * Excludes ADMIN-bit holders who are themselves the collection's
 * defaultAdmin (creator) — that's handled at the call site, not here,
 * because a creator's KV entry already comes back via
 * `/api/collections?artist=…`.
 */
export async function findMintableCollections(
  client: GetLogsClient,
  candidates: Address[],
  viewer: Address,
): Promise<Address[]> {
  if (candidates.length === 0) return []
  const MINT_MASK = PERMISSION_BIT_ADMIN | PERMISSION_BIT_MINTER
  const logs = await client.getLogs({
    address: candidates,
    event: UPDATED_PERMISSIONS_EVENT,
    args: { tokenId: 0n, user: viewer },
    fromBlock: 'earliest',
    toBlock: 'latest',
  })
  // Latest event per collection wins. Same dedupe shape as
  // useCollectionMinters — keep this consistent so an audit of one
  // tells you everything about the other.
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
    if ((perms & MINT_MASK) !== 0n) out.push(addr as Address)
  }
  return out
}
