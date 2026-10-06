'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { MomentImage } from './MomentImage'
import { artworkTitle } from '@/lib/experience/format'

export interface KismetPayload {
  total: number
  machines: { id: string; name: string; kind: 'capsule' | 'reveal'; state: string; cover: string | null; kismet: number }[]
  history: {
    machineId: string
    machineName: string | null
    kind: 'play' | 'collect'
    collection: string
    tokenId: string
    name: string | null
    image: string | null
    txHash: string
    unitIndex: number
    at: number
  }[]
}

/** A person's kismet and what the gachapons gave them (/api/experience/kismet). */
export function useKismet(address: string) {
  const [data, setData] = useState<KismetPayload | null>(null)
  const load = useCallback(() => {
    fetch(`/api/experience/kismet?account=${address}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: KismetPayload | null) => setData(d))
      .catch(() => setData(null))
  }, [address])
  useEffect(() => { load() }, [load])
  return data
}

const day = (at: number) => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

/**
 * The profile's kismet: one for each capsule opened and each piece collected
 * from a gachapon, by machine, and the pieces themselves, newest first. A
 * count of what someone has done here — it buys nothing.
 */
export function ProfileKismet({ data }: { data: KismetPayload }) {
  return (
    <div className="flex flex-col gap-5">
      <p className="text-[11px] font-mono text-muted leading-relaxed">
        <span className="text-ink">{data.total} kismet</span> — one for each capsule opened and each piece collected from a
        gachapon.
      </p>
      {data.machines.length > 0 && (
        <div className="border border-line divide-y divide-line">
          {data.machines.map((m) => (
            <Link key={m.id} href={`/play/${m.id}`} className="flex items-center gap-3 px-3 py-2 hover:bg-raised transition-colors">
              <div className="relative w-9 h-9 shrink-0 overflow-hidden border border-line bg-raised">
                {m.cover && <MomentImage src={m.cover} alt="" fill className="object-cover" sizes="36px" preferProxy />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-mono text-dim truncate">{m.name}</p>
                <p className="text-[10px] font-mono text-subtle">
                  {m.kind === 'capsule' ? 'capsule machine' : 'reveal machine'}
                  {m.state !== 'live' && ' · closed'}
                </p>
              </div>
              <span className="text-xs font-mono tabular-nums text-ink shrink-0">{m.kismet} kismet</span>
            </Link>
          ))}
        </div>
      )}
      {data.history.length > 0 && (
        <div>
          <p className="text-[10px] font-mono uppercase tracking-widest text-subtle mb-2">what the machines gave</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {data.history.map((h) => (
              <div key={`${h.txHash}:${h.unitIndex}:${h.collection}:${h.tokenId}`} className="min-w-0">
                <Link href={`/artwork/${h.collection}/${h.tokenId}`} className="group block">
                  <div className="relative aspect-square overflow-hidden border border-line bg-raised">
                    {h.image ? (
                      <MomentImage src={h.image} alt="" fill className="object-cover" sizes="(max-width: 640px) 50vw, 33vw" />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-subtle">#{h.tokenId}</div>
                    )}
                  </div>
                  <p className="mt-1.5 text-[11px] font-mono text-ink truncate group-hover:underline">{artworkTitle(h.name, h.tokenId)}</p>
                </Link>
                <p className="text-[10px] font-mono text-subtle truncate">
                  {h.kind === 'play' ? 'opened from' : 'collected from'}{' '}
                  <Link href={`/play/${h.machineId}`} className="text-dim hover:text-ink">{h.machineName ?? h.machineId}</Link> · {day(h.at)}
                </p>
                {h.kind === 'play' && (
                  <Link
                    href={`/play/${h.machineId}/verify?txHash=${h.txHash}&unitIndex=${h.unitIndex}`}
                    className="text-[10px] font-mono text-subtle hover:text-dim underline"
                  >
                    verify
                  </Link>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
