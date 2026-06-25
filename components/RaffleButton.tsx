'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAccount, useReadContract, useSignMessage } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import type { Address } from 'viem'
import { toast } from 'sonner'
import { ERC1155_ABI } from '@/lib/seaport'
import { toastError } from '@/lib/toast'
import { buildRaffleEntryMessage } from '@/lib/raffleMessage'

interface RaffleButtonProps {
  collectionAddress: string
  tokenId: string
  // Layout knobs mirrored from ListButton so the swap is drop-in at the
  // existing owned-edition call sites.
  buttonClassName?: string
  stacked?: boolean
}

interface RaffleStatus {
  enabled: boolean
  open: boolean
  entrantCount: number
  entered: boolean
  winner: string | null
  winnerChosen: boolean
  isWinner: boolean
}

// Shared button chrome so every raffle state lines up with the surrounding
// "list"/"collect" buttons (same height, font, tracking).
const BASE_BTN =
  'w-full text-xs font-mono tracking-wider uppercase px-3 py-2.5 transition-colors'

/**
 * Replaces ListButton on owned editions of a raffle-enabled moment: surfaces
 * the off-chain raffle as a single button whose label + action follow the
 * collector through the flow —
 *
 *   enter raffle  → sign a gas-less message; the server records the entry
 *   raffle ✓      → entered, awaiting the admin's pick (disabled)
 *   you won       → the admin chose you (disabled; you keep your edition,
 *                   the physical is fulfilled off-platform)
 *   not selected  → entered but not chosen (disabled)
 *
 * Non-custodial and on nothing-moves: entering is just a signed flag recorded
 * server-side, re-verified against on-chain ownership. The admin picks the
 * winner manually (no on-chain randomness).
 */
export function RaffleButton({
  collectionAddress,
  tokenId,
  buttonClassName,
  stacked: _stacked = false,
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

  // Once status loads, hide entirely if no raffle is enabled for this moment.
  // CollectedActions already gates the swap on raffleEnabledKeys; this also
  // covers call sites that render RaffleButton directly (e.g. PatronArtwork).
  if (status && !status.enabled) return null

  // Show to current holders and to anyone already entered (so an entrant who
  // moved their edition still sees "you won" / "not selected").
  if (!holdsToken && !entered) return null

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
        body: JSON.stringify({
          collection: collectionAddress,
          tokenId,
          address,
          issuedAt,
          signature,
        }),
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

  // --- A winner has been announced. ---
  if (status?.winnerChosen) {
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
    if (entered) {
      return (
        <button
          disabled
          className={`${className} border border-line text-muted cursor-default`}
          title="Not selected — you keep your edition and your mint access"
        >
          not selected
        </button>
      )
    }
    // Winner announced and this holder never entered — nothing to show.
    return null
  }

  // --- Entered, awaiting the draw. ---
  if (entered) {
    return (
      <button
        disabled
        className={`${className} border border-accent/50 text-accent cursor-default`}
        title="You’re entered — the winner is chosen after entries close"
      >
        raffle ✓
      </button>
    )
  }

  // --- Entries closed but no winner yet, and not entered — nothing to do. ---
  if (status && !status.open) return null

  // --- Default: holder who hasn't entered → enter. ---
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
