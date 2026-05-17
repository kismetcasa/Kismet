'use client'

import { formatEther, formatUnits } from 'viem'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { MAX_COLLECT_ALL_BATCH } from '@/lib/zoraMint'
import { useCollectAll } from '@/hooks/useCollectAll'

interface CollectAllActionProps {
  collectionAddress: string
  // ETH-eligible tokens (FixedPriceSaleStrategy). Either or both of the eth/
  // usdc lists may be empty; the button hides only when both are empty.
  ethEligibleTokenIds: string[]
  // Sum of pricePerToken across the ETH-eligible tokens (wei). The actual
  // on-chain value is recomputed at submit time and includes the per-token
  // mintFee.
  ethEligibleTotalWei: string
  // USDC-eligible tokens (ERC20Minter). Mixed with the ETH leg into a single
  // EIP-5792 wallet_sendCalls bundle.
  usdcEligibleTokenIds: string[]
  // Sum of pricePerToken across USDC-eligible tokens (USDC base units, 6 dp).
  usdcEligibleTotalUsdc: string
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

// USDC has 6 decimals; trim to ≤2 to match how prices are typically quoted.
function formatUsdcChip(amount: bigint): string {
  const full = formatUnits(amount, 6)
  if (!full.includes('.')) return full
  const [whole, frac] = full.split('.')
  const trimmed = frac.slice(0, 2).replace(/0+$/, '')
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
 * mints — across ETH (1155.mint per token) and USDC (ERC20Minter calls) — into
 * a single EIP-5792 wallet_sendCalls. Atomic on supporting wallets, sequential
 * fallback on others.
 *
 * Returns null when nothing's eligible at all (sale ended, sold out, exotic
 * non-USDC currency). Mixed-currency collections show "Ξ X + $Y" so the
 * cost is unambiguous.
 */
export function CollectAllAction({
  collectionAddress,
  ethEligibleTokenIds,
  ethEligibleTotalWei,
  usdcEligibleTokenIds,
  usdcEligibleTotalUsdc,
}: CollectAllActionProps) {
  const ethCount = ethEligibleTokenIds.length
  const usdcCount = usdcEligibleTokenIds.length
  const totalCount = ethCount + usdcCount
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { collectAll, status } = useCollectAll()

  if (totalCount === 0) return null

  const inFlight = status !== 'idle' && status !== 'done' && status !== 'error'
  const batchSize = Math.min(totalCount, MAX_COLLECT_ALL_BATCH)
  const ethTotalWei = BigInt(ethEligibleTotalWei)
  const usdcTotalUsdc = BigInt(usdcEligibleTotalUsdc)

  // Cost label: combine when both legs have value, otherwise show just the
  // active currency. "free" is reserved for the (rare) case where every
  // eligible token is priced at 0.
  let costLabel: string
  if (ethTotalWei === 0n && usdcTotalUsdc === 0n) {
    costLabel = 'free'
  } else if (ethTotalWei > 0n && usdcTotalUsdc > 0n) {
    costLabel = `Ξ ${formatEthChip(ethTotalWei)} + $${formatUsdcChip(usdcTotalUsdc)}`
  } else if (ethTotalWei > 0n) {
    costLabel = `Ξ ${formatEthChip(ethTotalWei)}`
  } else {
    costLabel = `$${formatUsdcChip(usdcTotalUsdc)}`
  }

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
    <div className="flex items-stretch gap-1.5">
      <span className="px-2 py-1.5 text-xs font-mono border border-line text-dim whitespace-nowrap">
        {costLabel}
      </span>
      <button
        onClick={handleClick}
        disabled={inFlight}
        className="flex-1 py-1.5 text-xs font-mono border border-accent/40 text-accent hover:border-accent hover:bg-accent/10 transition-colors disabled:opacity-60 disabled:cursor-wait"
      >
        {label}
      </button>
    </div>
  )
}
