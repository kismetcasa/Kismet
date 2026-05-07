import { type Address } from 'viem'
import { isAddress } from '@/lib/address'
import { INPROCESS_API } from '@/lib/inprocess'
import { serverBaseClient } from '@/lib/rpc'

const PERMISSION_BIT_ADMIN = 2n

const COLLECTION_PERMISSIONS_ABI = [
  {
    name: 'permissions',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'user', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

/**
 * Result of a smart-wallet ADMIN preflight read.
 *   - `'authorized'` — smart wallet has ADMIN at one of the requested
 *     scopes. Caller should let the request through.
 *   - `'unauthorized'` — both reads succeeded and neither row holds
 *     ADMIN. Caller should return AUTHORIZE_REQUIRED.
 *   - `'unknown'` — RPC, smart-wallet lookup, or upstream call failed
 *     before we could form a definitive answer. Caller should fall
 *     through and let inprocess be the source of truth — a flaky
 *     RPC shouldn't deny a user whose state on chain is actually
 *     fine. Inprocess's own gas estimation will catch a real failure.
 */
export type PreflightResult = 'authorized' | 'unauthorized' | 'unknown'

/**
 * Resolve the artist's inprocess smart wallet for `callerEoa`, then
 * read on-chain `permissions(tokenId, smartWallet)` for each tokenId
 * in `tokenIds`. The grants ARE OR'd together — same as Zora's
 * `_hasAnyPermission` — so a single ADMIN bit at any provided scope
 * counts as authorized.
 *
 * Use this before forwarding admin-mint or moment-create userOps to
 * inprocess: a smart wallet that doesn't hold ADMIN guarantees the
 * userOp reverts at gas estimation. Catching that ahead of time
 * avoids burning a nonce / round-tripping to inprocess only to fail.
 *
 * Caller responsibilities:
 *   - Pass the appropriate scopes. For airdrops on existing tokens,
 *     pass [tokenId, 0n] — Zora ORs both rows, so either suffices.
 *     For new-token creation (mint into a collection), pass [0n] —
 *     setupNewToken requires collection-wide ADMIN.
 *   - On `'unknown'`, fall through. Don't surface the read error to
 *     the user — just let the upstream call proceed and inprocess
 *     will be the source of truth.
 */
export async function checkSmartWalletAdmin(
  callerEoa: string,
  collectionAddress: string,
  tokenIds: bigint[],
): Promise<PreflightResult> {
  if (!isAddress(callerEoa) || !isAddress(collectionAddress) || tokenIds.length === 0) {
    return 'unknown'
  }
  try {
    const smartWalletUrl = new URL(`${INPROCESS_API}/smartwallet`)
    smartWalletUrl.searchParams.set('artist_wallet', callerEoa)
    const swRes = await fetch(smartWalletUrl.toString(), {
      headers: { Accept: 'application/json' },
      next: { revalidate: 3600 },
    })
    if (!swRes.ok) return 'unknown'
    const swData = (await swRes.json()) as { address?: string }
    const smartWallet = swData.address
    if (!smartWallet || !isAddress(smartWallet)) return 'unknown'

    const client = serverBaseClient()
    const safeRead = async (tid: bigint): Promise<bigint | null> => {
      try {
        return (await client.readContract({
          address: collectionAddress as Address,
          abi: COLLECTION_PERMISSIONS_ABI,
          functionName: 'permissions',
          args: [tid, smartWallet as Address],
        })) as bigint
      } catch {
        return null
      }
    }
    const reads = await Promise.all(tokenIds.map((tid) => safeRead(tid)))
    // Any read failure → 'unknown'. We require ALL reads to succeed
    // before declaring 'unauthorized', so a single RPC blip can't
    // produce a false negative.
    if (reads.some((r) => r === null)) return 'unknown'
    const effective = (reads as bigint[]).reduce((acc, r) => acc | r, 0n)
    return (effective & PERMISSION_BIT_ADMIN) === PERMISSION_BIT_ADMIN
      ? 'authorized'
      : 'unauthorized'
  } catch {
    return 'unknown'
  }
}
