'use client'

import { formatEther } from 'viem'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { MAX_COLLECT_ALL_BATCH } from '@/lib/zoraMint'
import { useCollectAll } from '@/hooks/useCollectAll'

interface CollectAllActionProps {
  collectionAddress: string
  // ETH-eligible token IDs pre-filtered by the server. The hook re-checks
  // eligibility client-side at click time (sale window may have shifted,
  // and we then filter by the connected account's balances).
  ethEligibleTokenIds: string[]
  // Sum of pricePerToken across the eligible tokens (wei). Used for the
  // cost preview chip; the actual on-chain value is recomputed at submit
  // time and includes the per-token mintFee.
  ethEligibleTotalWei: string
}

// Trim a wei value's formatted ether string to ≤4 decimal places, dropping
// trailing zeroes. Keeps the cost chip narrow without lying about precision.
function formatEthChip(wei: bigint): string {
  const full = formatEther(wei)
  if (!full.includes('.')) return full
  const [whole, frac] = full.split('.')
  const trimmed = frac.slice(0, 4).replace(/0+$/, '')
  return trimmed ? `${whole}.${trimmed}` : whole
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
 * Cost-preview chip + "collect all" button. Bundles up to MAX_COLLECT_ALL_BATCH
 * per-token mints into a single Zora 1155 multicall (one wallet signature).
 *
 * Returns null when nothing's ETH-eligible (USDC-only collections, sold-out,
 * or sale ended) — we don't surface a partial CTA there.
 */
export function CollectAllAction({
  collectionAddress,
  ethEligibleTokenIds,
  ethEligibleTotalWei,
}: CollectAllActionProps) {
  const eligibleCount = ethEligibleTokenIds.length
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { collectAll, status } = useCollectAll()

  if (eligibleCount === 0) return null

  const inFlight = status !== 'idle' && status !== 'done' && status !== 'error'
  const batchSize = Math.min(eligibleCount, MAX_COLLECT_ALL_BATCH)
  const totalWei = BigInt(ethEligibleTotalWei)
  const costLabel = totalWei > 0n ? `Ξ ${formatEthChip(totalWei)}` : 'free'

  function handleClick() {
    if (!isConnected) {
      openConnectModal?.()
      return
    }
    collectAll({
      collectionAddress: collectionAddress as `0x${string}`,
      candidateTokenIds: ethEligibleTokenIds,
    })
  }

  const label = inFlight
    ? statusLabel(status)
    : `collect all (${batchSize}${eligibleCount > MAX_COLLECT_ALL_BATCH ? ` of ${eligibleCount}` : ''})`

  return (
    <div className="flex items-stretch gap-1.5">
      <span className="px-2 py-1.5 text-xs font-mono border border-[#2a2a2a] text-[#888] whitespace-nowrap">
        {costLabel}
      </span>
      <button
        onClick={handleClick}
        disabled={inFlight}
        className="flex-1 py-1.5 text-xs font-mono border border-[#8B5CF6]/40 text-[#8B5CF6] hover:border-[#8B5CF6] hover:bg-[#8B5CF6]/10 transition-colors disabled:opacity-60 disabled:cursor-wait"
      >
        {label}
      </button>
    </div>
  )
}
