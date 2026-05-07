import type { Address } from 'viem'

// viem's PublicClient is generic over <Transport, Chain> and Base's OP-Stack
// transaction extensions (deposit txns) don't match the default-chain
// transaction union. That means PublicClient (no generics) and
// PublicClient<HttpTransport, typeof base> (what serverBaseClient returns)
// aren't assignable to each other through a function parameter. We only
// need readContract here, so type the input as a structural minimum —
// viem's `as const` ABI inference below preserves type safety on the
// actual call shape; the bigint cast at the call site handles the
// `unknown` return.
type PublicClientLike = {
  readContract: (args: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args: readonly unknown[]
  }) => Promise<unknown>
}

// Zora 1155 PermissionsConstants — cross-checked against
// @zoralabs/zora-1155-contracts and https://github.com/sweetmantech/docs-in-process
// (page: moment/permission). Bit *value* (1<<n), not bit position.
//
//   ADMIN          = 1<<1 = 2   — read/write any token; can grant/revoke roles
//   MINTER         = 1<<2 = 4   — can mint copies via setupNewToken/sale
//   SALES          = 1<<3 = 8   — can configure sale strategies
//   METADATA       = 1<<4 = 16  — can update tokenURI
//   FUNDS_MANAGER  = 1<<5 = 32  — can manage funds recipient
//
// Single source of truth — every server route, hook, and component
// in the app imports from here. Previously these constants were
// redefined ad-hoc in 5+ places; consolidating prevents drift if
// Zora ever ships a v2 with different bit assignments (and prevents
// the most likely human bug: someone setting bit value `1` thinking
// it's the first role, when bit *position* 0 has no role and ADMIN
// starts at value 2).
export const PERMISSION_BIT_ADMIN = 2n
export const PERMISSION_BIT_MINTER = 4n
export const PERMISSION_BIT_SALES = 8n
export const PERMISSION_BIT_METADATA = 16n
export const PERMISSION_BIT_FUNDS_MANAGER = 32n

// Minimal ABI fragment — only the `permissions` view fn. Lets this module
// import cleanly on the client without dragging in the full COLLECTION_ABI
// (which references several write functions that wagmi's tree-shaking
// already exposes elsewhere).
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
 * Thrown when `permissions()` decodes to a non-bigint — structural
 * (proxy upgrade, wrong chain, ABI drift) rather than transient.
 * Distinguished as its own error type so readPermissions's retry
 * loop can break out immediately instead of wasting ~5s of backoff
 * waiting for an RPC fix that won't come.
 */
export class NonBigIntPermsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NonBigIntPermsError'
  }
}

/**
 * Read a single (tokenId, user) permission row. Wraps the contract read
 * with a few retries — Base's public RPC and even paid providers can
 * lag the chain head for a few seconds after a deploy/grant tx confirms,
 * which surfaces as a false-zero permission read. The retry mirrors the
 * pattern in app/api/collections/route.ts:293-312 so post-deploy
 * verification doesn't false-fail on propagation lag.
 *
 * Returns the permission bitmap (uint256) on success. Throws on every
 * attempt failing — callers decide whether to treat that as 'unknown'
 * (preflight semantics, fall through) or 'fatal' (post-deploy verify).
 *
 * Two failure modes; both retry-able vs not:
 *   - Transient (RPC throws / network timeout / rate limit): retry up
 *     to `retries` times with backoff.
 *   - Structural (NonBigIntPermsError — contract decoded to wrong
 *     shape): no point retrying, fail fast on the first observation.
 *     Saves ~5s of latency per call when a contract is genuinely
 *     misconfigured (the healthcheck takes that slow path, audit
 *     endpoint reads malformed contracts, etc.).
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
      // Runtime guard. The ABI declares uint256 → bigint, but if the
      // contract was ever swapped at this address (proxy upgrade, wrong
      // chain, malformed bytecode, ABI drift) viem might decode to a
      // string or number instead. A silent unsafe cast would feed a
      // non-bigint into hasAdminBit() and the bitwise AND would surface
      // as falsy — we'd interpret a "broken read" as "missing ADMIN"
      // and fire false-negative warnings everywhere.
      if (typeof result !== 'bigint') {
        throw new NonBigIntPermsError(
          `permissions(${tokenId}, ${user}) on ${collection} returned non-bigint: ${typeof result}`,
        )
      }
      return result
    } catch (err) {
      lastErr = err
      // Structural failure: skip the rest of the retry schedule.
      // No amount of backoff will turn a non-bigint return into
      // a bigint return; that requires a contract / ABI change.
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

/**
 * Effective permissions for `user` on `tokenId`. Mirrors Zora's
 * `_hasAnyPermission`: a row is granted at the per-token scope OR the
 * collection-wide scope (tokenId 0). Returns the bitwise OR so any
 * downstream `hasAdminBit` / role check works uniformly.
 *
 * Pass tokenId=0n to read just collection-wide scope (skipping the
 * redundant second read). Pass any other tokenId to OR both scopes.
 */
export async function effectivePermissions(
  client: PublicClientLike,
  collection: Address,
  user: Address,
  tokenId: bigint,
): Promise<bigint> {
  if (tokenId === 0n) {
    return readPermissions(client, collection, 0n, user)
  }
  const [tokenScope, collectionScope] = await Promise.all([
    readPermissions(client, collection, tokenId, user),
    readPermissions(client, collection, 0n, user),
  ])
  return tokenScope | collectionScope
}

/**
 * Result of a post-deploy permission verification. Surface-level shape
 * (`ok` + structured detail) is intentionally NOT a Promise<boolean> so
 * callers can render the failure to the user with enough context to
 * actually fix it (which wallet is missing which bit, what the perms
 * read returned). `detail` is safe to surface in a toast.
 */
export interface VerifyDeployResult {
  ok: boolean
  /** Bitmap read for the deployer EOA (defaultAdmin) at tokenId 0. */
  deployerPerms: bigint
  /** Bitmap read for the smart wallet at tokenId 0 (granted via setupActions). */
  smartWalletPerms: bigint
  /** Human-readable message for the success toast or the failure error. */
  detail: string
}

/**
 * Post-deploy fail-closed verification. Reads BOTH permission rows that a
 * Kismet deploy MUST set:
 *   - permissions(0, deployerEOA)   ← from defaultAdmin in createContract
 *   - permissions(0, smartWallet)   ← from inprocessAdminAction setupAction
 *
 * Both must include the ADMIN bit. If either is missing, we DID NOT in fact
 * end up with a usable collection — every subsequent /moment/create against
 * it will revert with UserMissingRoleForToken at gas estimation, the user
 * will see "Authorize required" with no recoverable path (since the smart
 * wallet has no ADMIN to grant via the banner). We return ok=false here so
 * CreateCollectionForm fails closed instead of marking step='done'.
 *
 * The retry behavior in readPermissions covers RPC propagation lag — by the
 * time this returns ok=false we've genuinely confirmed both rows are 0 on
 * chain across 4 attempts.
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
