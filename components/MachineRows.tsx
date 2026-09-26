import Link from 'next/link'
import { shortAddress } from '@/lib/inprocess'

export interface MachineRow {
  id: string
  name: string
  kind: 'capsule' | 'reveal'
  creator: string
  state: string
}

/** The machine list as /experience and the Discover "play" tab show it. */
export function MachineRows({ machines }: { machines: MachineRow[] }) {
  return (
    <div className="border border-line divide-y divide-line">
      {machines.map((m) => (
        <Link
          key={m.id}
          href={`/experience/${m.id}`}
          className="flex items-center gap-3 px-4 py-3.5 hover:bg-raised transition-colors"
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
      ))}
    </div>
  )
}
