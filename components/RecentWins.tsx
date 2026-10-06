'use client'

import Link from 'next/link'
import { MomentImage } from './MomentImage'
import { GachaponShareButton } from './GachaponShareButton'
import { artworkTitle } from '@/lib/experience/format'

/** What came out of a machine lately, to whom (the machine route's recentWins). */
export interface RecentWin {
  player: string
  collection: string
  tokenId: string
  txHash: string
  unitIndex: number
  /** Who made the artwork; null when the machine no longer lists it. */
  artist: string | null
  name: string | null
  image: string | null
}

/**
 * A machine's recent winners: each wallet with a winner tag and what it won,
 * and — for the one viewing, on their own wins — a way to share it.
 */
export function RecentWins({
  machineId,
  wins,
  account,
  nameOf,
}: {
  machineId: string
  wins: RecentWin[]
  /** The connected wallet, lowercased. */
  account: string | null
  nameOf: (address: string) => string
}) {
  if (wins.length === 0) return null
  return (
    <section className="mt-6">
      <h2 className="text-[11px] font-mono uppercase tracking-widest text-muted mb-2">recent wins</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {wins.map((w) => {
          const mine = !!account && w.player === account
          return (
            <div key={`${w.txHash}:${w.unitIndex}:${w.tokenId}`} className="flex items-center gap-3 border border-line px-2 py-2 min-w-0">
              <Link href={`/artwork/${w.collection}/${w.tokenId}`} className="relative w-10 h-10 shrink-0 overflow-hidden border border-line bg-raised">
                {w.image ? (
                  <MomentImage src={w.image} alt="" fill className="object-cover" sizes="40px" />
                ) : (
                  <span className="absolute inset-0 flex items-center justify-center text-[8px] font-mono text-subtle">#{w.tokenId}</span>
                )}
              </Link>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-mono truncate">
                  <Link href={`/profile/${w.player}`} className="text-dim hover:text-ink">{mine ? 'you' : nameOf(w.player)}</Link>{' '}
                  <span className="ml-1 px-1.5 py-px text-[9px] uppercase tracking-wider border border-accent text-accent">winner</span>
                </p>
                <p className="text-[10px] font-mono text-subtle truncate">won {artworkTitle(w.name, w.tokenId)}</p>
              </div>
              {mine && w.artist && (
                <GachaponShareButton
                  share={{ machineId, collection: w.collection, tokenId: w.tokenId, title: w.name, artist: w.artist }}
                  className="shrink-0 text-[10px] font-mono text-dim hover:text-ink underline"
                />
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
