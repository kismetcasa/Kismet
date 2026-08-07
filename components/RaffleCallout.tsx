'use client'

import { useEffect, useState } from 'react'
import { useAccount, useReadContract } from 'wagmi'
import type { Address } from 'viem'
import { Ticket } from 'lucide-react'
import { ERC1155_ABI } from '@/lib/seaport'
import { useAdmin } from '@/contexts/AdminContext'
import { fetchCreatorProfilesBatch } from '@/lib/profileCache'
import { ProfileAvatar } from './ProfileAvatar'

interface RaffleCalloutStatus {
  enabled: boolean
  ended: boolean
  entriesOpen: boolean
  entriesCloseAt: number | null
  entrantCount: number
  recentEntrants?: string[]
}

// "Aug 12" — month + day in the viewer's locale. Client-only by construction
// (this component renders nothing until its status fetch resolves, which is
// post-mount), so there's no SSR/hydration timezone mismatch to guard.
const closeDay = (unixSec: number) =>
  new Date(unixSec * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

/**
 * The public raffle callout on the artwork detail page — the raffle selling
 * itself to prospective collectors. While a raffle is live it REPLACES the
 * sale-window date in the action toolbar, as two centered lines so it fits
 * the slot on both breakpoints:
 *
 *   Collect to enter raffle to win physical artwork
 *              14 entrants · closes Aug 21
 *
 * The headline adapts to the viewer: a wallet that already holds the edition
 * has nothing left to collect, so it reads "Enter raffle to win physical
 * artwork" instead. (Count omitted at zero, "closes …" omitted when entries
 * never auto-close, the whole meta line omitted when both are absent.)
 * Once entries close it shows "raffle entries closed · winner announced soon";
 * when the raffle has ended — or the artwork has no raffle — it renders the
 * `fallback` (the SaleWindow this slot normally holds).
 *
 * Zero cost for the 99% of artworks with no raffle: gated on the
 * raffleEnabledKeys set AdminContext already loads once on mount, so the
 * status fetch (and the holder balance read) only fire for raffle-enabled
 * artworks.
 */
export function RaffleCallout({
  collection,
  tokenId,
  fallback,
}: {
  collection: string
  tokenId: string
  fallback: React.ReactNode
}) {
  const { raffleEnabledKeys } = useAdmin()
  const hasRaffle = raffleEnabledKeys.has(`${collection.toLowerCase()}:${tokenId}`)
  const [status, setStatus] = useState<RaffleCalloutStatus | null>(null)
  // Does the viewer already hold the edition? Drives the headline variant
  // ("Enter raffle …" vs "Collect to enter raffle …"). Same read RaffleButton
  // does; gated on a live raffle so non-raffle artworks never pay the call.
  const { address } = useAccount()
  const { data: balance } = useReadContract({
    address: collection as Address,
    abi: ERC1155_ABI,
    functionName: 'balanceOf',
    args: address ? [address, BigInt(tokenId)] : undefined,
    query: { enabled: !!address && hasRaffle },
  })
  const holds = balance !== undefined && (balance as bigint) > 0n
  // address (lowercased) → avatarUrl, so entrants show their real pfp like
  // every other ProfileAvatar surface (gradient identicon only as fallback).
  const [avatars, setAvatars] = useState<Record<string, string | undefined>>({})

  useEffect(() => {
    if (!hasRaffle) return
    let cancelled = false
    const params = new URLSearchParams({ collection, tokenId })
    fetch(`/api/raffle/status?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setStatus(d as RaffleCalloutStatus)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [hasRaffle, collection, tokenId])

  // Resolve the strip's real avatar images (batched, LRU-cached client-side —
  // one /api/profiles call for all six at most). Keyed lowercased, matching
  // fetchCreatorProfilesBatch's output.
  useEffect(() => {
    const addrs = (status?.entriesOpen ? (status.recentEntrants ?? []) : []).slice(0, 6)
    if (addrs.length === 0) return
    let cancelled = false
    fetchCreatorProfilesBatch(addrs)
      .then((profiles) => {
        if (cancelled) return
        setAvatars(
          Object.fromEntries(
            addrs.map((a) => [a.toLowerCase(), profiles[a.toLowerCase()]?.avatarUrl]),
          ),
        )
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [status])

  // No raffle, still loading, or already resolved → the normal sale window.
  // (While the status fetch is in flight the fallback shows; a live raffle
  // then swaps it for the callout — same client-late timing SaleWindow itself
  // has, so the slot never flashes empty.)
  if (!hasRaffle || !status?.enabled || status.ended) return <>{fallback}</>

  const headline = status.entriesOpen
    ? holds
      ? 'Enter raffle to win physical artwork'
      : 'Collect to enter raffle to win physical artwork'
    : 'Raffle entries closed · winner announced soon'
  // Second, centered line: entrant count + close date. Empty (and omitted)
  // when there's neither; the closed state carries no meta by construction.
  const meta = status.entriesOpen
    ? [
        status.entrantCount > 0
          ? `${status.entrantCount} entrant${status.entrantCount === 1 ? '' : 's'}`
          : null,
        status.entriesCloseAt != null ? `closes ${closeDay(status.entriesCloseAt)}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : ''

  // Recent-entrants social proof — a restrained overlapping-avatar cluster
  // under the copy lines, only while entries are open and someone's entered.
  // Addresses come with the status payload (no extra request); cap at 6.
  const recent = status.entriesOpen ? (status.recentEntrants ?? []).slice(0, 6) : []

  return (
    <div className="flex flex-col items-center gap-1 min-w-0">
      <div className="flex items-center gap-1.5 min-w-0">
        <Ticket size={11} className="flex-shrink-0 text-accent" />
        <span className="text-[10px] font-mono uppercase tracking-widest text-dim text-center">
          {headline}
        </span>
      </div>
      {meta && (
        <span className="text-[10px] font-mono uppercase tracking-widest text-muted text-center">
          {meta}
        </span>
      )}
      {recent.length > 0 && (
        // Square avatars (the house ProfileAvatar shape), overlapped with a
        // page-background ring so each edge stays readable in the stack.
        <div className="flex items-center -space-x-1.5" aria-label="recent raffle entrants">
          {recent.map((a) => (
            <div key={a} className="ring-2 ring-[#0d0d0d]">
              <ProfileAvatar address={a} avatarUrl={avatars[a.toLowerCase()]} size={16} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
