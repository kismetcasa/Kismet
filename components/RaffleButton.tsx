'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAccount, useReadContract, useSignMessage } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import type { Address } from 'viem'
import { toast } from 'sonner'
import { ERC1155_ABI } from '@/lib/seaport'
import { toastError } from '@/lib/toast'
import { buildRaffleEntryMessage } from '@/lib/raffleMessage'
import { ListButton, type ListButtonProps } from './ListButton'

interface RaffleButtonProps {
  collectionAddress: string
  tokenId: string
  // Layout knobs mirrored from ListButton so the swap is drop-in at the
  // existing owned-edition call sites.
  buttonClassName?: string
  stacked?: boolean
  // Full ListButton props, so the button can fall through to "list" for a
  // released non-winner (ended, didn't win) or a holder who never entered once
  // entries close. Omitted at call sites with no listing affordance (e.g.
  // PatronArtwork) — there those cases just render nothing.
  listProps?: ListButtonProps
}

interface RaffleStatus {
  enabled: boolean
  ended: boolean
  entriesOpen: boolean
  entered: boolean
  isWinner: boolean
}

// Shared button chrome so every raffle state lines up with the surrounding
// "list"/"collect" buttons (same height, font, tracking).
const BASE_BTN =
  'w-full text-xs font-mono tracking-wider uppercase px-3 py-2.5 transition-colors'

/**
 * The owned-edition action for a moment that hosts a raffle. A single button
 * that follows the holder through the lifecycle:
 *
 *   enter raffle  → sign a gas-less message; the server records the entry
 *   raffle ✓      → entered, awaiting the draw (disabled)
 *   you won ✓     → the draw picked you (you keep your edition; physical
 *                   fulfilment is off-platform)
 *   (released)    → ended and you didn't win, or entries closed and you never
 *                   entered → fall through to the normal "list" action
 *
 * Non-custodial and nothing-moves: entering is just a signed flag recorded
 * server-side, re-verified against on-chain ownership. The winner is drawn from
 * eligible (still-holding) entrants by the artist's "draw & end" action.
 */
export function RaffleButton({
  collectionAddress,
  tokenId,
  buttonClassName,
  stacked: _stacked = false,
  listProps,
}: RaffleButtonProps) {
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { signMessageAsync } = useSignMessage()

  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<RaffleStatus | null>(null)

  // Editions the wallet holds. Gates whether the button shows at all; an
  // entrant still sees their state even if they later transfer the edition.
  const { data: balance } = useReadContract({
    address: collectionAddress as Address,
    abi: ERC1155_ABI,
    functionName: 'balanceOf',
    args: address ? [address, BigInt(tokenId)] : undefined,
    query: { enabled: !!address },
  })
  const holdsToken = balance !== undefined && (balance as bigint) > 0n

  const fetchStatus = useCallback(async () => {
    try {
      const params = new URLSearchParams({ collection: collectionAddress, tokenId })
      if (address) params.set('address', address)
      const r = await fetch(`/api/raffle/status?${params.toString()}`)
      if (r.ok) setStatus((await r.json()) as RaffleStatus)
    } catch {
      // Soft-fail: the button just falls back to its pre-status label.
    }
  }, [collectionAddress, tokenId, address])

  useEffect(() => {
    void fetchStatus()
  }, [fetchStatus])

  const entered = status?.entered ?? false
  const className = `${BASE_BTN} ${buttonClassName ?? ''}`
  // Fall-through to the marketplace "list" action where one is available.
  const renderList = () => (listProps ? <ListButton {...listProps} /> : null)

  async function enterRaffle() {
    if (!isConnected || !address) {
      openConnectModal?.()
      return
    }
    try {
      setBusy(true)
      const issuedAt = Math.floor(Date.now() / 1000)
      const message = buildRaffleEntryMessage({
        collection: collectionAddress,
        tokenId,
        address,
        issuedAt,
      })
      toast.loading('Sign to enter the raffle…', { id: 'raffle' })
      const signature = await signMessageAsync({ message })

      const r = await fetch('/api/raffle/enter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: collectionAddress, tokenId, address, issuedAt, signature }),
      })
      const data = (await r.json().catch(() => ({}))) as { error?: string }
      if (!r.ok) throw new Error(data.error ?? 'Could not enter the raffle')
      toast.success('You’re in the raffle!', { id: 'raffle' })
      await fetchStatus()
    } catch (err) {
      toastError('Raffle', err, { id: 'raffle' })
    } finally {
      setBusy(false)
    }
  }

  // No raffle (or just disabled) → the normal listing action.
  if (status && !status.enabled) return renderList()

  // --- Raffle ended. ---
  if (status?.ended) {
    if (status.isWinner) {
      return (
        <button
          disabled
          className={`${className} border border-accent bg-accent/10 text-accent cursor-default`}
          title="You won! We’ll be in touch about your physical piece — your edition stays yours."
        >
          you won ✓
        </button>
      )
    }
    // Didn't win → released back to the normal listing action.
    return renderList()
  }

  // --- Entered, awaiting the draw. ---
  if (entered) {
    return (
      <button
        disabled
        className={`${className} border border-accent/50 text-accent cursor-default`}
        title={
          status && !status.entriesOpen
            ? 'Entries closed — the winner is drawn next'
            : 'You’re entered — the winner is drawn after entries close'
        }
      >
        raffle ✓
      </button>
    )
  }

  // --- Not entered. ---
  // Entries closed and you never entered → you're not in the raffle → list.
  if (status && !status.entriesOpen) return renderList()
  // Not a holder and not entered → nothing to do here (list if available).
  if (!holdsToken) return renderList()

  // Holder, entries open, not entered → enter.
  return (
    <button
      onClick={enterRaffle}
      disabled={busy}
      className={`${className} border border-line text-muted enabled:hover:border-accent enabled:hover:text-accent disabled:opacity-50`}
      title="Enter the raffle — a free signature; your edition stays in your wallet"
    >
      {busy ? 'entering…' : 'enter raffle'}
    </button>
  )
}
