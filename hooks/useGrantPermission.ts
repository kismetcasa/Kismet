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

/** String alias over the bigint constants — call-sites use the bit
 *  name they're granting instead of importing raw bigints. */
export type PermissionBit = 'admin' | 'minter' | 'metadata'

const BIT_VALUES: Record<PermissionBit, bigint> = {
  admin: PERMISSION_BIT_ADMIN,
  minter: PERMISSION_BIT_MINTER,
  metadata: PERMISSION_BIT_METADATA,
}

export interface GrantPermissionRequest {
  collection: `0x${string}`
  grantee: `0x${string}`
  /** 0n = collection-wide; nonzero scopes the grant to one tokenId.
   *  Zora's _hasAnyPermission ORs both rows, so granting at either is
   *  sufficient — but the caller must hold ADMIN on the row they write. */
  tokenId: bigint
  bit: PermissionBit
}

export type GrantOutcome = 'already' | 'submitted'

/** A single permission write inside a batch. Heterogeneous batches let
 *  the "Authorize creators" upgrade clear the redundant MINTER row in
 *  the same tx that grants ADMIN. */
export interface PermissionOp extends GrantPermissionRequest {
  direction: 'grant' | 'revoke'
}

type ReadContractClient = {
  readContract: (args: {
    address: `0x${string}`
    abi: typeof COLLECTION_ABI
    functionName: 'permissions'
    args: readonly [bigint, `0x${string}`]
  }) => Promise<unknown>
}

// Strip ops that would be on-chain no-ops (bit already in the requested
// state). Reads each (collection, tokenId, grantee) once, ORing per-
// token + collection-wide rows the same way Zora's _hasAnyPermission
// does. Read failures fall through as "unknown" = keep the op — the
// chain will safely no-op a redundant write.
async function filterRedundant(
  client: ReadContractClient,
  ops: PermissionOp[],
): Promise<PermissionOp[]> {
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
    ops.map(async (op) => {
      // Read per-token AND collection-wide rows in parallel (Zora's
      // _hasAnyPermission ORs both). Skip the collection-wide read
      // when tokenId is already 0n — same row.
      const [tokenPerms, collPerms] = await Promise.all([
        safeRead(op.collection, op.tokenId, op.grantee),
        op.tokenId === 0n
          ? Promise.resolve(0n)
          : safeRead(op.collection, 0n, op.grantee),
      ])
      return tokenPerms | collPerms
    }),
  )
  return ops.filter((op, i) => {
    const bit = BIT_VALUES[op.bit]
    const isSet = (reads[i] & bit) === bit
    return op.direction === 'grant' ? !isSet : isSet
  })
}

/**
 * Centralizes addPermission / removePermission writes for every authorize
 * surface in the app: AirdropForm self-authorize, CollectionView's
 * authorize banner, the post-deploy Authorize creators / minters panels,
 * and MomentDetailView's delegate-airdrop grant.
 *
 * `grant` / `revoke` are sugar for single-op batches. `batch` accepts
 * mixed-direction ops and routes through Zora's inherited
 * `multicall(bytes[])` so paired writes (e.g. grant ADMIN + clear
 * redundant MINTER on an upgrade) land in one signature.
 *
 * Every path pre-reads perms and short-circuits no-ops so the wallet
 * isn't prompted for redundant writes. RPC read failures fall through
 * as "unknown" = keep the op (chain safely no-ops redundant writes).
 */
export function useGrantPermission() {
  const { address: connected } = useAccount()
  const publicClient = usePublicClient({ chainId: base.id })
  const { writeContractAsync } = useWriteContract()
  const ensureBase = useEnsureBase()

  const [busy, setBusy] = useState(false)
  const [hash, setHash] = useState<`0x${string}` | undefined>(undefined)
  const { data: receipt } = useWaitForTransactionReceipt({
    hash,
    // Pin to Base so the receipt is read from the same chain the grant tx
    // was written to, regardless of the connector's currently-reported chain.
    chainId: base.id,
    query: { enabled: !!hash },
  })

  async function batch(ops: PermissionOp[]): Promise<GrantOutcome> {
    if (!connected) throw new Error('Wallet not connected')
    if (!publicClient) throw new Error('No network client available')
    if (ops.length === 0) return 'already'
    const collection = ops[0].collection
    if (ops.some((op) => op.collection !== collection)) {
      throw new Error('batch: all ops must target the same collection')
    }
    setBusy(true)
    try {
      const filtered = await filterRedundant(publicClient, ops)
      if (filtered.length === 0) return 'already'
      await ensureBase()
      // Single op: direct addPermission/removePermission saves the
      // multicall dispatch overhead and gives etherscan a recognizable
      // tx label. Multiple ops: route through inherited multicall.
      if (filtered.length === 1) {
        const op = filtered[0]
        const txHash = await writeContractAsync({
          chainId: base.id,
          address: collection,
          abi: COLLECTION_ABI,
          functionName:
            op.direction === 'grant' ? 'addPermission' : 'removePermission',
          args: [op.tokenId, op.grantee, BIT_VALUES[op.bit]],
        })
        setHash(txHash)
        return 'submitted'
      }
      const calls = filtered.map((op) =>
        encodeFunctionData({
          abi: COLLECTION_ABI,
          functionName:
            op.direction === 'grant' ? 'addPermission' : 'removePermission',
          args: [op.tokenId, op.grantee, BIT_VALUES[op.bit]],
        }),
      )
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

  const grant = (req: GrantPermissionRequest) =>
    batch([{ ...req, direction: 'grant' }])
  const revoke = (req: GrantPermissionRequest) =>
    batch([{ ...req, direction: 'revoke' }])

  /** Release the receipt watcher so the hook is ready for another tx. */
  const reset = () => setHash(undefined)

  return {
    grant,
    revoke,
    batch,
    reset,
    /** True while the precheck reads or the tx submission is in flight. */
    busy,
    /** Last submitted tx hash; undefined when no tx pending or after reset(). */
    hash,
    /** Receipt object once the tx confirms; undefined while pending. */
    receipt,
  }
}
