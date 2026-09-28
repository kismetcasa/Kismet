import Link from 'next/link'
import { shortAddress } from '@/lib/inprocess'
import { MachineAction } from './MachineAction'

export type MachineRow = { id: string; name: string; creator: string; state: string } & (
  | { kind: 'reveal' }
  /** `capsule` is what ending the machine closes on-chain. */
  | { kind: 'capsule'; capsule: { collection: string; tokenId: string } }
)

/** The machine list as /experience and the Discover "play" tab show it. Its
 *  creator also sees how to end a live machine, beside it. */
export function MachineRows({ machines, onEnded }: { machines: MachineRow[]; onEnded?: (id: string) => void }) {
  return (
    <div className="border border-line divide-y divide-line">
      {machines.map((m) => (
        <div key={m.id} className="flex flex-wrap items-center">
          <Link
            href={`/experience/${m.id}`}
            className="flex-1 min-w-0 flex items-center gap-3 px-4 py-3.5 hover:bg-raised transition-colors"
          >
            <span className="flex-1 min-w-0 text-sm font-mono text-ink truncate">{m.name}</span>
            <span className="text-[10px] font-mono text-subtle shrink-0">{m.kind}</span>
            <span className="text-[10px] font-mono text-subtle shrink-0">{shortAddress(m.creator)}</span>
            <span
              className={`text-[10px] font-mono uppercase tracking-wider shrink-0 ${
                m.state === 'live' ? 'text-accent' : 'text-subtle'
              }`}
            >
              {m.state === 'live' ? 'live' : 'closed'}
            </span>
          </Link>
          {m.state === 'live' && (
            <MachineAction
              machine={m}
              action="end"
              creator={m.creator}
              onDone={onEnded}
              triggerClassName="shrink-0 pr-4 text-[10px] font-mono text-dim hover:text-ink underline"
              panelClassName="basis-full px-4 pb-3"
            />
          )}
        </div>
      ))}
    </div>
  )
}
