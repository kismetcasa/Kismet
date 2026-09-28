'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { Address } from 'viem'
import { useDirectCollect } from '@/hooks/useDirectCollect'
import { useEnsureConnected } from '@/hooks/useEnsureConnected'
import { formatPrice, shortAddress } from '@/lib/inprocess'
import { pickIndex } from '@/lib/experience/draw'
import { artworkTitle } from '@/lib/experience/format'
import { MomentImage } from './MomentImage'
import { MachineAction } from './MachineAction'

/**
 * A reveal machine: pull for free, see one artwork, collect it at its price.
 *
 * Nothing here is sold by the machine. A pull picks one of the pieces on sale
 * right now, uniformly, and the collect button is the artwork's own collect —
 * its sale, its price, its split, the same transaction its page would send. So
 * a pull costs nothing and skipping a piece loses nothing, which is why there
 * is no limit on pulls and no fairness proof to publish: the odds are 1 in N
 * over the list below, and the pull draws from that same list in the browser.
 */

interface LineupRow {
  key: string
  collection: string
  tokenId: string
  artist: string
  sale: { pricePerToken: string; currency: 'eth' | 'usdc'; saleEnd: number }
  name: string | null
  image: string | null
}

interface Payload {
  machine: { id: string; name: string; state: string; creator: string }
  /** Who earns the mint referral on collects from this machine: its curator,
   *  or null when Kismet curates (Kismet's own referral then applies). */
  referral: string | null
  lineup: LineupRow[]
  waiting: number
  /** Linked collections: new work minted into them joins by itself. */
  collections: string[]
}

/** Long enough to read as a capsule opening, short enough not to be a wait. */
const REVEAL_MS = 700

export function RevealMachine({ id }: { id: string }) {
  const ensureConnected = useEnsureConnected()
  const { collect, status } = useDirectCollect()
  const [data, setData] = useState<Payload | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [pick, setPick] = useState<LineupRow | null>(null)
  const [pulling, setPulling] = useState(false)
  const [collected, setCollected] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(() => {
    fetch(`/api/experience/machines/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: Payload) => { setData(d); setLoadError(false) })
      .catch(() => setLoadError(true))
  }, [id])
  useEffect(load, [load])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const pull = useCallback(() => {
    if (!data || data.lineup.length === 0 || pulling) return
    setPulling(true)
    setPick(null)
    setCollected(null)
    const next = data.lineup[pickIndex(data.lineup.length)]
    timer.current = setTimeout(() => { setPick(next); setPulling(false) }, REVEAL_MS)
  }, [data, pulling])

  const collecting = status !== 'idle' && status !== 'done' && status !== 'error'
  const collectPick = useCallback(async () => {
    if (!pick || collecting) return
    if (!(await ensureConnected())) return
    const done = await collect({
      collectionAddress: pick.collection as Address,
      tokenId: pick.tokenId,
      amount: 1,
      share: { momentName: pick.name, creatorAddress: pick.artist },
      curator: data?.referral,
    })
    if (done) {
      setCollected(pick.key)
      // The piece may have just sold out; the lineup should say so.
      load()
    }
  }, [collect, collecting, data?.referral, ensureConnected, load, pick])

  if (loadError) {
    return <p className="max-w-3xl mx-auto text-sm font-mono text-muted">This machine could not be loaded.</p>
  }
  if (!data) return <p className="max-w-3xl mx-auto text-sm font-mono text-subtle">loading…</p>

  const live = data.machine.state === 'live'
  const n = data.lineup.length

  return (
    <div className="max-w-3xl mx-auto">
      <header className="mb-6">
        <h1 className="text-lg font-mono tracking-wider text-ink">{data.machine.name}</h1>
        <p className="text-[11px] font-mono text-muted mt-1">
          curated by {shortAddress(data.machine.creator)} · pull for free, collect what you reveal at its price
        </p>
        {data.collections.length > 0 && (
          <p className="text-[11px] font-mono text-subtle mt-1">
            auto-updating · new work minted into{' '}
            {data.collections.map((c, i) => (
              <span key={c}>
                {i > 0 && ', '}
                <Link href={`/collection/${c}`} className="text-dim hover:text-ink underline">{shortAddress(c)}</Link>
              </span>
            ))}{' '}
            joins by itself
          </p>
        )}
        {live && (
          <MachineAction machine={{ id: data.machine.id, kind: 'reveal' }} action="end" creator={data.machine.creator} onDone={load} />
        )}
      </header>

      <div className="border border-line bg-surface p-6 sm:p-10 text-center">
        {pick ? (
          <div>
            <p className="text-xs font-mono uppercase tracking-widest accent-grad">you revealed</p>
            <Link href={`/artwork/${pick.collection}/${pick.tokenId}`} className="group block mt-5">
              <div className="relative overflow-hidden border border-line bg-raised aspect-square max-w-[15rem] mx-auto">
                {pick.image ? (
                  <MomentImage src={pick.image} alt="" fill className="object-cover" sizes="240px" />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-subtle">
                    #{pick.tokenId}
                  </div>
                )}
              </div>
              <p className="mt-2 text-[11px] font-mono text-ink truncate group-hover:underline">
                {artworkTitle(pick.name, pick.tokenId)}
              </p>
              <p className="text-[10px] font-mono text-muted truncate">by {shortAddress(pick.artist)}</p>
            </Link>
            <div className="mt-5 flex flex-wrap gap-2 justify-center">
              {collected === pick.key ? (
                <p className="px-4 py-2 text-xs font-mono tracking-widest uppercase text-[#7ee787]">collected</p>
              ) : (
                <button
                  onClick={() => void collectPick()}
                  disabled={collecting}
                  className="px-6 py-3 text-xs font-mono tracking-widest uppercase btn-accent disabled:opacity-40"
                >
                  {collecting ? 'collecting…' : `collect · ${formatPrice(pick.sale.pricePerToken, pick.sale.currency)}`}
                </button>
              )}
              {live && (
                <button
                  onClick={pull}
                  disabled={collecting || n === 0}
                  className="px-6 py-3 text-xs font-mono tracking-widest uppercase border border-line text-dim hover:text-ink disabled:opacity-40"
                >
                  pull again
                </button>
              )}
            </div>
            {collected !== pick.key && (
              <p className="mt-2.5 text-[11px] font-mono text-muted">
                paid to the artist through its own sale <span className="text-subtle">+ network fee</span>
              </p>
            )}
          </div>
        ) : (
          <div>
            <p className="text-xs font-mono uppercase tracking-widest text-muted">
              {pulling ? 'opening…' : !live ? 'this machine is closed' : n === 0 ? 'nothing on sale right now' : 'free to pull'}
            </p>
            <button
              onClick={pull}
              disabled={!live || n === 0 || pulling}
              className="mt-5 px-6 py-3 text-xs font-mono tracking-widest uppercase btn-accent disabled:opacity-40"
            >
              {pulling ? 'working…' : 'pull'}
            </button>
            {live && n === 0 && data.waiting > 0 && (
              <p className="mt-2.5 text-[11px] font-mono text-muted">
                {data.waiting} {data.waiting === 1 ? 'piece joins' : 'pieces join'} when {data.waiting === 1 ? 'its sale opens' : 'their sales open'}
              </p>
            )}
          </div>
        )}
      </div>

      <section className="mt-8">
        <h2 className="text-[11px] font-mono uppercase tracking-widest text-muted mb-3">
          what&apos;s inside · {n === 0 ? 'nothing on sale' : n === 1 ? 'one piece, always revealed' : `each piece is 1 in ${n}`}
        </h2>
        {n > 0 && (
          <div className="border border-line divide-y divide-line">
            {data.lineup.map((p) => (
              <Link
                key={p.key}
                href={`/artwork/${p.collection}/${p.tokenId}`}
                className="flex items-center gap-3 px-3 py-2.5 hover:bg-raised transition-colors"
              >
                <div className="relative w-10 h-10 shrink-0 overflow-hidden border border-line bg-raised">
                  {p.image ? (
                    <MomentImage src={p.image} alt="" fill className="object-cover" sizes="40px" />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-[8px] font-mono text-subtle">
                      #{p.tokenId}
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-mono text-dim truncate">{artworkTitle(p.name, p.tokenId)}</p>
                  <p className="text-[10px] font-mono text-subtle truncate">by {shortAddress(p.artist)}</p>
                </div>
                <span className="shrink-0 text-xs font-mono tabular-nums text-ink">
                  {formatPrice(p.sale.pricePerToken, p.sale.currency)}
                </span>
              </Link>
            ))}
          </div>
        )}
        <p className="text-[11px] font-mono text-subtle mt-2 max-w-xl leading-relaxed">
          Only pieces on sale right now are inside. One that sells out or closes leaves by itself
          {data.waiting > 0 && n > 0 &&
            `, and ${data.waiting} more ${data.waiting === 1 ? 'joins when its sale opens' : 'join when their sales open'}`}.
        </p>
      </section>
    </div>
  )
}
