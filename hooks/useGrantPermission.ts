'use client'

import { useState } from 'react'
import {
  useAccount,
  usePublicClient,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { base } from 'wagmi/chains'
import { encodeFunctionData } from 'viem'
import { COLLECTION_ABI } from '@/lib/collections'
import {
  PERMISSION_BIT_ADMIN,
  PERMISSION_BIT_METADATA,
  PERMISSION_BIT_MINTER,
} from '@/lib/permissions'
import { ZORA_MULTICALL_ABI } from '@/lib/zoraMint'
import { useEnsureBase } from '@/lib/useEnsureBase'

// String-keyed alias over the bigint constants in lib/permissions.ts.
// Exposed so call-sites (banners, picker UIs) don't have to import the
// bigints directly — the bit name is the user-facing label they're
// granting. The lookup table below is the single bridge between the
// names and the canonical constants.
export type PermissionBit = 'admin' | 'minter' | 'metadata'

const BIT_VALUES: Record<PermissionBit, bigint> = {
  admin: PERMISSION_BIT_ADMIN,
  minter: PERMISSION_BIT_MINTER,
  metadata: PERMISSION_BIT_METADATA,
}

export interface GrantPermissionRequest {
  /** Target collection contract */
  collection: `0x${string}`
  /** Address being granted the bit (commonly the inprocess smart wallet
   *  for self-grants, or another EOA when the creator is delegating) */
  grantee: `0x${string}`
  /** Token scope. 0n is collection-wide; a specific tokenId restricts the
   *  grant to that token. Zora's _hasAnyPermission ORs both rows when
   *  evaluating, so granting at either is sufficient — but the caller
   *  must hold ADMIN on the same row they're writing to. */
  tokenId: bigint
  /** Which permission to grant */
  bit: PermissionBit
}

export type GrantOutcome = 'already' | 'submitted'

type ReadContractClient = {
  readContract: (args: {
    address: `0x${string}`
    abi: typeof COLLECTION_ABI
    functionName: 'permissions'
    args: readonly [bigint, `0x${string}`]
  }) => Promise<unknown>
}

// Strip grants that would be on-chain no-ops (bit already in the
// requested state). Reads each (collection, tokenId, grantee) once,
// ORing per-token + collection-wide rows the same way Zora's
// _hasAnyPermission does. Read failures fall through as "unknown" =
// keep the grant — the chain will safely no-op a redundant write.
async function filterRedundant(
  client: ReadContractClient,
  grants: GrantPermissionRequest[],
  goal: 'set' | 'clear',
): Promise<GrantPermissionRequest[]> {
  const safeRead = async (
    collection: `0x${string}`,
    tokenId: bigint,
    grantee: `0x${string}`,
  ): Promise<bigint> => {
    try {
      return (await client.readContract({
        address: collection,
        abi: COLLECTION_ABI,
        functionName: 'permissions',
        args: [tokenId, grantee],
      })) as bigint
    } catch {
      return 0n
    }
  }
  const reads = await Promise.all(
    grants.map(async (g) => {
      const tokenPerms = await safeRead(g.collection, g.tokenId, g.grantee)
      const collPerms =
        g.tokenId === 0n
          ? 0n
          : await safeRead(g.collection, 0n, g.grantee)
      return tokenPerms | collPerms
    }),
  )
  return grants.filter((g, i) => {
    const bit = BIT_VALUES[g.bit]
    const isSet = (reads[i] & bit) === bit
    return goal === 'set' ? !isSet : isSet
  })
}

/**
 * Centralizes the on-chain `addPermission` flow that powers:
 *   - AirdropForm's smart-wallet self-authorize (per-token or collection-wide)
 *   - CollectionView's Authorize banner (collection-wide self-authorize)
 *   - CollectionView's "Authorize minters" UI (collection-wide MINTER grant
 *     to arbitrary addresses)
 *   - MomentDetailView's "Delegate airdrop" UI (per-token ADMIN grant)
 *
 * The on-chain primitive is the same in every case: read current
 * permissions to skip a no-op tx, then `addPermission(tokenId, grantee,
 * bit)` if the bit isn't already set. Caller wraps with their own
 * UX-specific toasts + side effects.
 *
 * Reads are wrapped to tolerate Base's public RPC rate limits — a flaky
 * read shouldn't surface as an error when we can just submit the tx.
 * `addPermission` is bitwise OR on the existing row, so re-granting an
 * already-set bit is a gas-only no-op.
 */
export function useGrantPermission() {
  const { address: connected } = useAccount()
  const publicClient = usePublicClient({ chainId: base.id })
  const { writeContractAsync } = useWriteContract()
  const ensureBase = useEnsureBase()

  const [busy, setBusy] = useState(false)
  const [hash, setHash] = useState<`0x${string}` | undefined>(undefined)
  const { data: receipt, error: receiptError } = useWaitForTransactionReceipt({
    hash,
    query: { enabled: !!hash },
  })

  /**
   * Submits the grant. Reads current perms (per-token AND collection-wide,
   * ORed — same as Zora's _hasAnyPermission) to short-circuit a no-op tx.
   * Returns:
   *   - 'already' when the bit is already set on chain (no tx submitted)
   *   - 'submitted' when the tx is in flight (caller should observe
   *     `receipt` via the returned state to handle confirmation/revert)
   * Throws on user rejection, RPC failure on the write, or missing
   * connected wallet — caller wraps with toastError.
   */
  async function grant({
    collection,
    grantee,
    tokenId,
    bit,
  }: GrantPermissionRequest): Promise<GrantOutcome> {
    if (!connected) throw new Error('Wallet not connected')
    if (!publicClient) throw new Error('No network client available')
    setBusy(true)
    try {
      const bitValue = BIT_VALUES[bit]
      const safeRead = async (tid: bigint): Promise<bigint> => {
        try {
          return (await publicClient.readContract({
            address: collection,
            abi: COLLECTION_ABI,
            functionName: 'permissions',
            args: [tid, grantee],
          })) as bigint
        } catch {
          return 0n
        }
      }
      const [tokenPerms, collectionPerms] = await Promise.all([
        safeRead(tokenId),
        tokenId === 0n ? Promise.resolve(0n) : safeRead(0n),
      ])
      const effective = tokenPerms | collectionPerms
      if ((effective & bitValue) === bitValue) return 'already'
      await ensureBase()
      const txHash = await writeContractAsync({
        chainId: base.id,
        address: collection,
        abi: COLLECTION_ABI,
        functionName: 'addPermission',
        args: [tokenId, grantee, bitValue],
      })
      setHash(txHash)
      return 'submitted'
    } finally {
      setBusy(false)
    }
  }

  /**
   * Mirror of `grant` for revoking a permission bit. Reads the same
   * (per-token | collection-wide) bitmap to short-circuit a no-op
   * removePermission, then submits the tx if the bit is currently set.
   * Caveat: revoking MINTER from a wallet that also holds ADMIN does
   * not strip mint capability — Zora's mint paths check ADMIN | MINTER.
   * The chain still accepts the tx; UI should warn or skip when relevant.
   */
  async function revoke({
    collection,
    grantee,
    tokenId,
    bit,
  }: GrantPermissionRequest): Promise<GrantOutcome> {
    if (!connected) throw new Error('Wallet not connected')
    if (!publicClient) throw new Error('No network client available')
    setBusy(true)
    try {
      const bitValue = BIT_VALUES[bit]
      const safeRead = async (tid: bigint): Promise<bigint> => {
        try {
          return (await publicClient.readContract({
            address: collection,
            abi: COLLECTION_ABI,
            functionName: 'permissions',
            args: [tid, grantee],
          })) as bigint
        } catch {
          return 0n
        }
      }
      const [tokenPerms, collectionPerms] = await Promise.all([
        safeRead(tokenId),
        tokenId === 0n ? Promise.resolve(0n) : safeRead(0n),
      ])
      const effective = tokenPerms | collectionPerms
      if ((effective & bitValue) === 0n) return 'already'
      await ensureBase()
      const txHash = await writeContractAsync({
        chainId: base.id,
        address: collection,
        abi: COLLECTION_ABI,
        functionName: 'removePermission',
        args: [tokenId, grantee, bitValue],
      })
      setHash(txHash)
      return 'submitted'
    } finally {
      setBusy(false)
    }
  }

  /**
   * Batch grant: encode each addPermission as bytes and route through the
   * inherited `multicall(bytes[])` entry every Zora 1155 inherits. Used
   * by the "Authorize creators" panel to grant ADMIN to the target's
   * smart wallet AND MINTER to their EOA in a single signature, so the
   * authorized user can both create new tokens (via inprocess relay
   * through their smart wallet) and airdrop copies directly from their
   * own wallet.
   *
   * Skips per-grant entries whose bit is already set on chain. Returns
   * 'already' when every entry is a no-op (no tx submitted). All grants
   * must target the same collection.
   */
  async function grantBatch(
    grants: GrantPermissionRequest[],
  ): Promise<GrantOutcome> {
    if (!connected) throw new Error('Wallet not connected')
    if (!publicClient) throw new Error('No network client available')
    if (grants.length === 0) return 'already'
    const collection = grants[0].collection
    if (grants.some((g) => g.collection !== collection)) {
      throw new Error('grantBatch: all grants must target the same collection')
    }
    setBusy(true)
    try {
      const filtered = await filterRedundant(publicClient, grants, 'set')
      if (filtered.length === 0) return 'already'
      const calls = filtered.map((g) =>
        encodeFunctionData({
          abi: COLLECTION_ABI,
          functionName: 'addPermission',
          args: [g.tokenId, g.grantee, BIT_VALUES[g.bit]],
        }),
      )
      await ensureBase()
      const txHash = await writeContractAsync({
        chainId: base.id,
        address: collection,
        abi: ZORA_MULTICALL_ABI,
        functionName: 'multicall',
        args: [calls],
      })
      setHash(txHash)
      return 'submitted'
    } finally {
      setBusy(false)
    }
  }

  /** Mirror of `grantBatch` for revokes. Skips entries whose bit is
   *  already cleared on chain (no-op revoke). */
  async function revokeBatch(
    grants: GrantPermissionRequest[],
  ): Promise<GrantOutcome> {
    if (!connected) throw new Error('Wallet not connected')
    if (!publicClient) throw new Error('No network client available')
    if (grants.length === 0) return 'already'
    const collection = grants[0].collection
    if (grants.some((g) => g.collection !== collection)) {
      throw new Error('revokeBatch: all grants must target the same collection')
    }
    setBusy(true)
    try {
      const filtered = await filterRedundant(publicClient, grants, 'clear')
      if (filtered.length === 0) return 'already'
      const calls = filtered.map((g) =>
        encodeFunctionData({
          abi: COLLECTION_ABI,
          functionName: 'removePermission',
          args: [g.tokenId, g.grantee, BIT_VALUES[g.bit]],
        }),
      )
      await ensureBase()
      const txHash = await writeContractAsync({
        chainId: base.id,
        address: collection,
        abi: ZORA_MULTICALL_ABI,
        functionName: 'multicall',
        args: [calls],
      })
      setHash(txHash)
      return 'submitted'
    } finally {
      setBusy(false)
    }
  }

  /** Clear the watched hash so the hook is ready for another grant.
   *  Callers should invoke this after acting on a receipt to release the
   *  watcher and reset state. */
  function reset() {
    setHash(undefined)
  }

  return {
    grant,
    grantBatch,
    revoke,
    revokeBatch,
    reset,
    /** True while the precheck reads or the tx submission is in flight. */
    busy,
    /** Last submitted tx hash; undefined when no tx pending or after reset(). */
    hash,
    /** Receipt object once the tx confirms; undefined while pending. */
    receipt,
    /** Set when the receipt watcher itself failed (network drop, tx never
     *  found). Distinct from `receipt.status === 'reverted'`, which means
     *  the tx confirmed but failed on-chain. */
    receiptError,
  }
}
