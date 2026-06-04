'use client'

import { formatEther, formatUnits } from 'viem'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { MAX_COLLECT_ALL_BATCH } from '@/lib/zoraMint'
import { BASE_CHAIN_ID } from '@/lib/chains'
import { useCollectAll } from '@/hooks/useCollectAll'

interface CollectAllActionProps {
  collectionAddress: string
  // Chain the collection lives on. Defaults to Base. The eligible token lists
  // were already computed on this chain server-side; this drives execution.
  chainId?: number
  // ETH-eligible tokens (FixedPriceSaleStrategy). Either or both of the eth/
  // usdc lists may be empty; the button hides only when both are empty.
  ethEligibleTokenIds: string[]
  // Sum of pricePerToken across the ETH-eligible tokens (wei). The actual
  // on-chain value is recomputed at submit time and includes the per-token
  // mintFee. Unused (and may be omitted) when `compact` is true.
  ethEligibleTotalWei?: string
  // USDC-eligible tokens (ERC20Minter). Mixed with the ETH leg into a single
  // EIP-5792 wallet_sendCalls bundle.
  usdcEligibleTokenIds: string[]
  // Sum of pricePerToken across USDC-eligible tokens (USDC base units, 6 dp).
  // Unused (and may be omitted) when `compact` is true.
  usdcEligibleTotalUsdc?: string
  // Compact mode: full-width button only, no cost chip. Used by the grid
  // discover cards where horizontal space is tight and per-card widths must
  // line up cleanly. Non-compact (default) keeps the chip + button row.
  compact?: boolean
  // Plain mode: borderless text-only action (no chip, no border, no count).
  // Brand gradient paints the text on hover. Used inline beside the
  // collection page's "artworks" heading.
  plain?: boolean
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
 * non-USDC currency).
 *
 * `compact` (used by the grid discover cards) drops the chip and spans the
 * row at full width so per-card widths line up cleanly when space is tight.
 * The wallet confirmation step is the source of truth on what gets charged
 * either way.
 *
 * Chip display policy (non-compact only — display-only; the action still
 * bundles both currencies):
 *   - all-ETH or mixed → Ξ total (USDC items ignored by the chip in mixed)
 *   - all-USDC         → $ total
 * Keeps the chip in a single currency so it reads at a glance. A later
 * pass can align the action with the chip if mixed-currency surprises
 * become an issue in the wallet flow.
 */
export function CollectAllAction({
  collectionAddress,
  chainId = BASE_CHAIN_ID,
  ethEligibleTokenIds,
  ethEligibleTotalWei,
  usdcEligibleTokenIds,
  usdcEligibleTotalUsdc,
  compact = false,
  plain = false,
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

  function handleClick() {
    if (!isConnected) {
      openConnectModal?.()
      return
    }
    collectAll({
      collectionAddress: collectionAddress as `0x${string}`,
      chainId,
      ethCandidateTokenIds: ethEligibleTokenIds,
      usdcCandidateTokenIds: usdcEligibleTokenIds,
    })
  }

  const label = inFlight
    ? statusLabel(status)
    : `collect all (${batchSize}${totalCount > MAX_COLLECT_ALL_BATCH ? ` of ${totalCount}` : ''})`

  // Plain text-only variant: inline beside a heading, brand gradient on hover.
  if (plain) {
    return (
      <button
        onClick={handleClick}
        disabled={inFlight}
        className="text-xs font-mono uppercase tracking-widest text-muted accent-grad-text-hover transition-colors disabled:opacity-60 disabled:cursor-wait whitespace-nowrap"
      >
        {inFlight ? statusLabel(status) : 'collect all'}
      </button>
    )
  }

  if (compact) {
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

  const ethTotalWei = BigInt(ethEligibleTotalWei ?? '0')
  const usdcTotalUsdc = BigInt(usdcEligibleTotalUsdc ?? '0')

  // USDC chip only when the collection is 100% USDC-priced; any ETH
  // presence flips to the ETH chip (mixed → ETH).
  const usdcOnly = ethCount === 0
  let costLabel: string
  if (usdcOnly) {
    costLabel = usdcTotalUsdc > 0n ? `$${formatUsdcChip(usdcTotalUsdc)}` : 'free'
  } else {
    costLabel = ethTotalWei > 0n ? `Ξ ${formatEthChip(ethTotalWei)}` : 'free'
  }

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
