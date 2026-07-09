import { type Address } from 'viem'
import { isAddress } from '@/lib/address'
import { hasAdminBit } from '@/lib/permissions'
import { resolveSmartWallet } from '@/lib/resolveSmartWallet'
import { serverBaseClient } from '@/lib/rpc'

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
 *   - `'unknown'` — RPC or a TRANSIENT smart-wallet lookup failure (null)
 *     before we could form a definitive answer. Caller should fall
 *     through and let inprocess be the source of truth — a flaky
 *     RPC shouldn't deny a user whose state on chain is actually
 *     fine. Inprocess's own gas estimation will catch a real failure.
 *   - `'no_account'` — the EOA has NO inprocess account (a DEFINITIVE
 *     notFound from /smartwallet). There is no smart wallet to hold
 *     ADMIN, so a relayed mint into an EXISTING collection is doomed to
 *     revert at gas estimation. Caller should surface a clean, actionable
 *     NO_ACCOUNT instead of forwarding. (Auto-deploy is unaffected — it
 *     has no existing-collection scope, so this preflight isn't run for it.)
 */
type PreflightStatus = 'authorized' | 'unauthorized' | 'unknown' | 'no_account'

interface PreflightDiagnostic {
  status: PreflightStatus
  /** Inprocess smart wallet resolved for the caller's EOA. Undefined
   *  when status='unknown' due to lookup failure. Surfaced to the
   *  client in AUTHORIZE_REQUIRED responses so users can verify it
   *  matches the address they granted ADMIN to. */
  smartWallet?: string
  /** Per-scope permission reads. Each entry has the tokenId queried
   *  and the bigint result, or null if the read errored (rate limit,
   *  network blip). Surfaced for diagnostics — a non-zero result
   *  without the ADMIN bit (e.g. 4n MINTER) tells the user they
   *  granted the wrong bit. */
  perms?: Array<{ tokenId: string; value: string | null }>
  /** Why we returned 'unknown'. Logged server-side; not surfaced to
   *  the client. */
  reason?: string
}

/**
 * MODEL (confirmed on-chain 2026 — full record in lib/resolveSmartWallet.ts):
 * `/moment/create` executes as the caller's PER-CREATOR inprocess smart wallet,
 * so THAT is the wallet whose ADMIN this preflight reads. The platform OPERATOR
 * wallet is the airdrop / admin-write path, NOT the mint executor — verified on
 * a live collection (permissions(0, operator)=0, permissions(0, perCreatorSW)=2).
 * Do not "fix" this preflight to read the operator instead.
 *
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
 *   - When returning AUTHORIZE_REQUIRED, include `smartWallet` and
 *     `perms` from the diagnostic in the response so users can see
 *     which address needs ADMIN and what bits they currently have.
 */
export async function checkSmartWalletAdmin(
  callerEoa: string,
  collectionAddress: string,
  tokenIds: bigint[],
): Promise<PreflightDiagnostic> {
  if (!isAddress(callerEoa) || !isAddress(collectionAddress) || tokenIds.length === 0) {
    return { status: 'unknown', reason: 'invalid inputs' }
  }
  // Use the shared resolver so this preflight, the local proxy, and
  // the audit endpoint all accept the same set of inprocess response
  // shapes (`address` / `smartWallet` / `smart_wallet` / `smartAccount`
  // / raw string). Previously this file had its own `swData.address`
  // parser that rejected legitimate non-canonical shapes and surfaced
  // them as `'unknown'` even when audit's GET would accept them —
  // divergent leniency between surfaces.
  let smartWallet: string | undefined
  try {
    const resolved = await resolveSmartWallet(callerEoa)
    // Distinguish the two no-smart-wallet cases. A DEFINITIVE notFound (the
    // EOA has no inprocess account) is permanent: there's no smart wallet to
    // hold ADMIN, so a relayed mint into THIS existing collection will revert
    // — surface a clean no_account so the caller returns an actionable error
    // instead of forwarding a doomed userOp. A TRANSIENT null (network/5xx/
    // timeout) returns 'unknown' so the caller falls through and lets inprocess
    // be the source of truth — a flaky read must not strand a user whose
    // on-chain state is actually fine.
    if (resolved && 'notFound' in resolved) {
      return { status: 'no_account', reason: 'no inprocess account for this EOA' }
    }
    if (!resolved) {
      return { status: 'unknown', reason: 'transient smart-wallet lookup failure' }
    }
    smartWallet = resolved.address

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
    const perms = tokenIds.map((tid, i) => ({
      tokenId: tid.toString(),
      value: reads[i] === null ? null : (reads[i] as bigint).toString(),
    }))
    // Any read failure → 'unknown'. We require ALL reads to succeed
    // before declaring 'unauthorized', so a single RPC blip can't
    // produce a false negative.
    if (reads.some((r) => r === null)) {
      return { status: 'unknown', smartWallet, perms, reason: 'rpc read failed' }
    }
    const effective = (reads as bigint[]).reduce((acc, r) => acc | r, 0n)
    const status: PreflightStatus = hasAdminBit(effective) ? 'authorized' : 'unauthorized'
    return { status, smartWallet, perms }
  } catch (err) {
    return {
      status: 'unknown',
      smartWallet,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}
