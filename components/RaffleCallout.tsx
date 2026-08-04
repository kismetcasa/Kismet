'use client'

import { useEffect, useState } from 'react'
import { Ticket } from 'lucide-react'
import { useAdmin } from '@/contexts/AdminContext'
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
 * The public raffle line on the artwork detail page — the raffle selling
 * itself to prospective collectors. While a raffle is live it REPLACES the
 * sale-window date in the action toolbar:
 *
 *   "Collect to enter raffle to win physical work · 14 entrants · closes Aug 12"
 *
 * (count omitted at zero, "closes …" omitted when entries never auto-close).
 * Once entries close it shows "raffle entries closed · winner announced soon";
 * when the raffle has ended — or the artwork has no raffle — it renders the
 * `fallback` (the SaleWindow this slot normally holds).
 *
 * Zero cost for the 99% of artworks with no raffle: gated on the
 * raffleEnabledKeys set AdminContext already loads once on mount, so the
 * status fetch only fires for raffle-enabled artworks.
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

  // No raffle, still loading, or already resolved → the normal sale window.
  // (While the status fetch is in flight the fallback shows; a live raffle
  // then swaps it for the callout — same client-late timing SaleWindow itself
  // has, so the slot never flashes empty.)
  if (!hasRaffle || !status?.enabled || status.ended) return <>{fallback}</>

  const label = status.entriesOpen
    ? [
        'Collect to enter raffle to win physical work',
        status.entrantCount > 0
          ? `${status.entrantCount} entrant${status.entrantCount === 1 ? '' : 's'}`
          : null,
        status.entriesCloseAt != null ? `closes ${closeDay(status.entriesCloseAt)}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : 'Raffle entries closed · winner announced soon'

  // Recent-entrants social proof — a restrained overlapping-avatar cluster
  // under the copy line, only while entries are open and someone's entered.
  // Addresses come with the status payload (no extra request); cap at 6.
  const recent = status.entriesOpen ? (status.recentEntrants ?? []).slice(0, 6) : []

  return (
    <div className="flex flex-col items-center gap-1.5 min-w-0">
      <div className="flex items-center gap-1.5 min-w-0">
        <Ticket size={11} className="flex-shrink-0 text-accent" />
        <span className="text-[10px] font-mono uppercase tracking-widest text-dim text-center">
          {label}
        </span>
      </div>
      {recent.length > 0 && (
        // Square avatars (the house ProfileAvatar shape), overlapped with a
        // background-colored ring so each edge stays readable in the stack.
        <div className="flex items-center -space-x-1.5" aria-label="recent raffle entrants">
          {recent.map((a) => (
            <div key={a} className="ring-2 ring-[#0d0d0d]">
              <ProfileAvatar address={a} size={16} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
