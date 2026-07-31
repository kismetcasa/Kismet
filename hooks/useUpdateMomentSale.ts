'use client'

import { usePublicClient, useWriteContract } from 'wagmi'
import { base } from 'wagmi/chains'
import type { Address, Hash } from 'viem'
import { COLLECTION_ABI } from '@/lib/collections'
import type { OnchainSaleConfig } from '@/lib/saleConfig'
import {
  buildSaleUpdateCall,
  readFullOnchainSale,
  resolveEditedWindow,
  resolveEndNow,
  saleToDisplayConfig,
  type FullOnchainSale,
  type WindowFieldEdit,
} from '@/lib/saleEdit'
import { useEnsureBase } from '@/lib/useEnsureBase'
import { BUILDER_DATA_SUFFIX } from '@/lib/builderCode'

export type UpdateSaleOutcome =
  /** Resolved window equals the live one — no tx sent, no wallet prompt. */
  | { status: 'unchanged' }
  | { status: 'updated'; hash: Hash; config: OnchainSaleConfig }

/**
 * Direct, user-signed sale-window edit on a Zora 1155 moment — the
 * sale-config sibling of useUpdateCollectionMetadata / useAirdrop's
 * admin-write family: `collection.callSale(tokenId, strategy,
 * setSale(tokenId, config))` from the connected wallet, which the UI gates
 * on ADMIN|SALES via useMomentSaleEditPermission (the same bits Zora's
 * `onlyAdminOrRole(tokenId, SALES)` checks, so the affordance can't outrun
 * the authorization).
 *
 * Direct (not inprocess-relayed) for the same reasons those hooks migrated
 * off the relay — the relay's operator wallet lacks ADMIN on auto-deployed
 * collections — plus one of its own: inprocess's POST /moment/sale takes
 * saleEnd as a JSON number and cannot carry the max-uint64 "never expires"
 * sentinel exactly. The artist's own wallet has none of those limits.
 *
 * Reads the FULL live sale row at submit time (chain is the merge base, not
 * display state, so a stale page can't resurrect an old price or recipient)
 * and rewrites only the window — everything else is carried through
 * unchanged by lib/saleEdit's pure core. Waits for the receipt and checks
 * `status` (a reverted callSale still yields a receipt) before reporting
 * success, so callers can treat 'updated' as final on-chain truth.
 */
export function useUpdateMomentSale() {
  const publicClient = usePublicClient({ chainId: base.id })
  const { writeContractAsync } = useWriteContract()
  const ensureBase = useEnsureBase()

  async function submit(
    collection: Address,
    tokenId: bigint,
    resolveWindow: (
      current: FullOnchainSale,
      nowSec: number,
    ) => { saleStart: bigint; saleEnd: bigint },
    onTxSubmitted?: () => void,
  ): Promise<UpdateSaleOutcome> {
    if (!publicClient) throw new Error('No network client available')
    const current = await readFullOnchainSale(publicClient, collection, tokenId)
    if (!current) throw new Error('No active sale to edit for this artwork')
    const nowSec = Math.floor(Date.now() / 1000)
    // resolveWindow throws user-facing validation errors (toastError-ready).
    const window = resolveWindow(current, nowSec)
    if (
      window.saleStart === current.saleStart &&
      window.saleEnd === current.saleEnd
    ) {
      return { status: 'unchanged' }
    }
    const { strategy, setSaleData } = buildSaleUpdateCall(tokenId, current, window)
    await ensureBase()
    const hash = await writeContractAsync({
      chainId: base.id,
      address: collection,
      abi: COLLECTION_ABI,
      functionName: 'callSale',
      args: [tokenId, strategy, setSaleData],
      dataSuffix: BUILDER_DATA_SUFFIX,
    })
    // Wallet prompt cleared — let the caller flip its toast copy from
    // "confirm in wallet" to "updating" while the receipt confirms.
    onTxSubmitted?.()
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error('Sale update reverted on-chain')
    return { status: 'updated', hash, config: saleToDisplayConfig(current, window) }
  }

  /** Apply the editor's start/end field edits (tri-state per field). */
  const updateWindow = (req: {
    collection: Address
    tokenId: bigint
    start: WindowFieldEdit
    end: WindowFieldEdit
    onTxSubmitted?: () => void
  }): Promise<UpdateSaleOutcome> =>
    submit(
      req.collection,
      req.tokenId,
      (current, nowSec) => {
        const resolved = resolveEditedWindow(
          current,
          { start: req.start, end: req.end },
          nowSec,
        )
        if (!resolved.ok) throw new Error(resolved.error)
        return { saleStart: resolved.saleStart, saleEnd: resolved.saleEnd }
      },
      req.onTxSubmitted,
    )

  /** Close the sale immediately (window ends now; a scheduled start zeroes). */
  const endNow = (req: {
    collection: Address
    tokenId: bigint
    onTxSubmitted?: () => void
  }): Promise<UpdateSaleOutcome> =>
    submit(
      req.collection,
      req.tokenId,
      (current, nowSec) => resolveEndNow(current, nowSec),
      req.onTxSubmitted,
    )

  return { updateWindow, endNow }
}
