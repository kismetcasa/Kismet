import Link from 'next/link'
import { formatPrice, shortAddress } from '@/lib/inprocess'
import type { MachineCardData } from '@/lib/experience/cards'
import { CoverCard } from './CoverCard'
import { MachineAction } from './MachineAction'

/** The machines as /play and the Discover "play" tab show them: a cover card
 *  each, two to a row from tablet width up. A live machine's creator also
 *  sees how to end it, on its card. */
export function MachineCards({ machines, onEnded }: { machines: MachineCardData[]; onEnded?: (id: string) => void }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {machines.map((m, i) => (
        <CoverCard
          key={m.id}
          href={`/play/${m.id}`}
          image={m.cover?.image}
          thumbhash={m.cover?.thumbhash}
          alt={m.name}
          sizes="(max-width: 640px) 100vw, 50vw"
          priority={i === 0}
        >
          <div className="flex items-center gap-3">
            <h3 className="flex-1 min-w-0 text-sm font-mono text-ink truncate">{m.name}</h3>
            <span
              className={`text-[10px] font-mono uppercase tracking-wider shrink-0 ${
                m.state === 'live' ? 'text-accent' : 'text-subtle'
              }`}
            >
              {m.state === 'live' ? 'live' : 'closed'}
            </span>
          </div>
          <p className="text-[11px] font-mono text-muted truncate">
            {m.kind} · by {shortAddress(m.creator)}
            {m.price && (
              <>
                {' · '}
                <span className="text-dim">{formatPrice(m.price.pricePerToken, m.price.currency)}</span> per play
              </>
            )}
          </p>
          <Link
            href={`/play/${m.id}`}
            className="w-full px-3 py-1.5 text-center text-xs font-mono border border-line text-dim hover:border-muted hover:text-ink transition-colors"
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
      ))}
    </div>
  )
}
