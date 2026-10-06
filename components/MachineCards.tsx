'use client'

import Link from 'next/link'
import { useEthUsd } from '@/hooks/useEthUsd'
import { useProfileNames } from '@/hooks/useProfileNames'
import { formatPrice } from '@/lib/inprocess'
import { ethUsdApprox } from '@/lib/usdApprox'
import type { MachineCardData } from '@/lib/experience/cards'
import { CoverCard } from './CoverCard'
import { MachineAction } from './MachineAction'

/** The machines as /play and the Discover "play" tab show them: a cover card
 *  each, two to a row on a phone as the artwork grid is, so a screen holds
 *  several. A live machine's creator also sees how to end it, on its card. */
export function MachineCards({ machines, onEnded }: { machines: MachineCardData[]; onEnded?: (id: string) => void }) {
  const ethUsd = useEthUsd()
  const nameOf = useProfileNames(machines.map((m) => m.creator))
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4">
      {machines.map((m, i) => {
        const usd = m.price?.currency === 'eth' ? ethUsdApprox(m.price.pricePerToken, ethUsd) : null
        return (
          <CoverCard
            key={m.id}
            href={`/play/${m.id}`}
            image={m.cover?.image}
            thumbhash={m.cover?.thumbhash}
            alt={m.name}
            sizes="50vw"
            priority={i < 2}
          >
            <div className="flex items-center gap-2">
              <h3 className="flex-1 min-w-0 text-xs sm:text-sm font-mono text-ink truncate">{m.name}</h3>
              <span
                className={`text-[9px] sm:text-[10px] font-mono uppercase tracking-wider shrink-0 ${
                  m.state === 'live' ? 'text-accent' : 'text-subtle'
                }`}
              >
                {m.state === 'live' ? 'live' : 'closed'}
              </span>
            </div>
            <p className="text-[10px] sm:text-[11px] font-mono text-muted truncate">
              {m.kind} · by {nameOf(m.creator)}
            </p>
            <p className="text-[10px] sm:text-[11px] font-mono text-muted truncate">
              {m.price ? (
                <>
                  <span className="text-dim">{formatPrice(m.price.pricePerToken, m.price.currency)}</span> per play
                  {usd && <span className="text-subtle"> {usd}</span>}
                </>
              ) : m.kind === 'reveal' ? (
                'free to pull'
              ) : (
                ' '
              )}
            </p>
            <Link
              href={`/play/${m.id}`}
              className="mt-auto w-full px-3 py-1.5 text-center text-xs font-mono border border-line text-dim hover:border-muted hover:text-ink transition-colors"
            >
              {m.state !== 'live' ? 'view' : m.kind === 'reveal' ? 'pull' : 'play'}
            </Link>
            {m.state === 'live' && (
              <MachineAction
                machine={m}
                action="end"
                creator={m.creator}
                onDone={onEnded}
                triggerClassName="self-start text-[11px] font-mono text-dim hover:text-ink underline"
                panelClassName="border-t border-line pt-2"
              />
            )}
          </CoverCard>
        )
      })}
    </div>
  )
}
