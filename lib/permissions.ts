import type { Address } from 'viem'

// Structural type for any viem PublicClient instance, regardless of its
// chain generic. Using `PublicClient` directly forces all callers to share
// the same chain (Base's OP-Stack txn extensions don't unify with the
// default chain), so we accept any client that exposes `readContract`.
type PublicClientLike = {
  readContract: (args: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args: readonly unknown[]
  }) => Promise<unknown>
}

// Zora 1155 PermissionsConstants. Bit *value* (1<<n), not bit position —
// e.g. ADMIN is bit position 1 with value 2. Cross-checked against
// @zoralabs/zora-1155-contracts.
//
//   ADMIN     = 1<<1 = 2
//   MINTER    = 1<<2 = 4
//   METADATA  = 1<<4 = 16
export const PERMISSION_BIT_ADMIN = 2n
export const PERMISSION_BIT_MINTER = 4n
export const PERMISSION_BIT_METADATA = 16n

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
 * Thrown when `permissions()` decodes to a non-bigint. Structural failure
 * (proxy upgrade, wrong chain, ABI drift) — distinct from a transient RPC
 * error, so `readPermissions` can fail fast instead of burning its retry
 * budget on a failure that won't resolve.
 */
class NonBigIntPermsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NonBigIntPermsError'
  }
}

/**
 * Read `permissions(tokenId, user)` on a Zora 1155 collection.
 *
 * Retries on transient RPC errors (Base RPCs commonly lag the chain head
 * for a few seconds after a tx confirms, surfacing as a false-zero read).
 * Bails immediately on `NonBigIntPermsError` since structural decode
 * failures don't recover with backoff.
 *
 * Returns the permission bitmap. Throws if every retry fails — callers
 * decide whether to treat the throw as 'unknown' (preflight: fall through)
 * or fatal (post-deploy verify: surface to user).
 */
export async function readPermissions(
  client: PublicClientLike,
  collection: Address,
  tokenId: bigint,
  user: Address,
  options: { retries?: number; backoffMs?: number } = {},
): Promise<bigint> {
  const retries = options.retries ?? 4
  const backoffMs = options.backoffMs ?? 500
  let lastErr: unknown = null
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const result = await client.readContract({
        address: collection,
        abi: COLLECTION_PERMISSIONS_ABI,
        functionName: 'permissions',
        args: [tokenId, user],
      })
      if (typeof result !== 'bigint') {
        throw new NonBigIntPermsError(
          `permissions(${tokenId}, ${user}) on ${collection} returned non-bigint: ${typeof result}`,
        )
      }
      return result
    } catch (err) {
      lastErr = err
      if (err instanceof NonBigIntPermsError) break
    }
    if (attempt < retries - 1) {
      await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** True iff the bitmap has the ADMIN bit set. */
export function hasAdminBit(perms: bigint): boolean {
  return (perms & PERMISSION_BIT_ADMIN) === PERMISSION_BIT_ADMIN
}

/** True iff the bitmap has the MINTER bit set. */
export function hasMinterBit(perms: bigint): boolean {
  return (perms & PERMISSION_BIT_MINTER) === PERMISSION_BIT_MINTER
}

export interface VerifyDeployResult {
  ok: boolean
  deployerPerms: bigint
  smartWalletPerms: bigint
  /** Human-readable diagnostic — safe to surface in a toast. */
  detail: string
}

/**
 * Post-deploy verification: confirms BOTH the deployer EOA and the
 * inprocess smart wallet hold ADMIN at tokenId 0 on a freshly-deployed
 * Zora 1155 collection. If either grant didn't take, every subsequent
 * mint via the inprocess relay would revert at gas estimation — so
 * deploy flows should treat `ok: false` as fail-closed and surface the
 * diagnostic instead of marking the deploy successful.
 */
export async function verifyDeployPermissions(
  client: PublicClientLike,
  collection: Address,
  deployerEoa: Address,
  smartWallet: Address,
): Promise<VerifyDeployResult> {
  const [deployerPerms, smartWalletPerms] = await Promise.all([
    readPermissions(client, collection, 0n, deployerEoa),
    readPermissions(client, collection, 0n, smartWallet),
  ])
  const deployerOk = hasAdminBit(deployerPerms)
  const smartWalletOk = hasAdminBit(smartWalletPerms)
  if (deployerOk && smartWalletOk) {
    return {
      ok: true,
      deployerPerms,
      smartWalletPerms,
      detail: `verified: deployer=${deployerPerms} smartWallet=${smartWalletPerms}`,
    }
  }
  const missing: string[] = []
  if (!deployerOk) missing.push(`deployer ${deployerEoa} perms=${deployerPerms}`)
  if (!smartWalletOk) missing.push(`smart wallet ${smartWallet} perms=${smartWalletPerms}`)
  return {
    ok: false,
    deployerPerms,
    smartWalletPerms,
    detail: `missing ADMIN: ${missing.join('; ')}`,
  }
}
