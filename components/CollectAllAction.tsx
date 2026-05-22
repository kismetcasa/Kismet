'use client'

import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { MAX_COLLECT_ALL_BATCH } from '@/lib/zoraMint'
import { useCollectAll } from '@/hooks/useCollectAll'

interface CollectAllActionProps {
  collectionAddress: string
  // ETH-eligible tokens (FixedPriceSaleStrategy). Either or both of the eth/
  // usdc lists may be empty; the button hides only when both are empty.
  ethEligibleTokenIds: string[]
  // USDC-eligible tokens (ERC20Minter). Mixed with the ETH leg into a single
  // EIP-5792 wallet_sendCalls bundle.
  usdcEligibleTokenIds: string[]
}

function statusLabel(status: ReturnType<typeof useCollectAll>['status']): string {
  switch (status) {
    case 'preparing':
      return 'preparing…'
    case 'minting':
      return 'confirm in wallet…'
    case 'confirming':
      return 'confirming…'
    case 'recording':
      return 'finalizing…'
    default:
      return 'collecting…'
  }
}

/**
 * Full-width "collect all" button. Bundles up to MAX_COLLECT_ALL_BATCH mints
 * — across ETH (1155.mint per token) and USDC (ERC20Minter calls) — into a
 * single EIP-5792 wallet_sendCalls. Atomic on supporting wallets, sequential
 * fallback on others.
 *
 * Returns null when nothing's eligible at all (sale ended, sold out, exotic
 * non-USDC currency). Cost is surfaced by the wallet's confirmation step
 * rather than a pre-flight chip — the on-chain value is recomputed at submit
 * time anyway (per-token mintFee).
 */
export function CollectAllAction({
  collectionAddress,
  ethEligibleTokenIds,
  usdcEligibleTokenIds,
}: CollectAllActionProps) {
  const totalCount = ethEligibleTokenIds.length + usdcEligibleTokenIds.length
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { collectAll, status } = useCollectAll()

  if (totalCount === 0) return null

  const inFlight = status !== 'idle' && status !== 'done' && status !== 'error'
  const batchSize = Math.min(totalCount, MAX_COLLECT_ALL_BATCH)

  function handleClick() {
    if (!isConnected) {
      openConnectModal?.()
      return
    }
    collectAll({
      collectionAddress: collectionAddress as `0x${string}`,
      ethCandidateTokenIds: ethEligibleTokenIds,
      usdcCandidateTokenIds: usdcEligibleTokenIds,
    })
  }

  const label = inFlight
    ? statusLabel(status)
    : `collect all (${batchSize}${totalCount > MAX_COLLECT_ALL_BATCH ? ` of ${totalCount}` : ''})`

  return (
    <button
      onClick={handleClick}
      disabled={inFlight}
      className="w-full py-1.5 text-xs font-mono border border-accent/40 text-accent hover:border-accent hover:bg-accent/10 transition-colors disabled:opacity-60 disabled:cursor-wait"
    >
      {label}
    </button>
  )
}
