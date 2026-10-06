'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { Address } from 'viem'
import { useAccount } from 'wagmi'
import { useDirectCollect } from '@/hooks/useDirectCollect'
import { useEnsureConnected } from '@/hooks/useEnsureConnected'
import { useEthUsd } from '@/hooks/useEthUsd'
import { useProfileNames } from '@/hooks/useProfileNames'
import { ethUsdApprox } from '@/lib/usdApprox'
import { formatPrice, shortAddress } from '@/lib/inprocess'
import { pickIndex } from '@/lib/experience/draw'
import { artworkTitle } from '@/lib/experience/format'
import { MomentImage } from './MomentImage'
import { MachineAction } from './MachineAction'
import { CollectedLine, MachineStage, motionAllowed, revealAfterOpen } from './MachineStage'
import { MachineArtEditors } from './MachineArtEditors'
import { GachaponShareButton } from './GachaponShareButton'
import { RecentWins, type RecentWin } from './RecentWins'
import type { MachineFrames } from '@/lib/experience/types'
import type { FrameStatus } from '@/lib/experience/cover'

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
  machine: { id: string; name: string; state: string; creator: string; cover: string | null; frames: MachineFrames | null; frameStatus: Partial<Record<keyof MachineFrames, FrameStatus>> | null }
  /** Who earns the mint referral on collects from this machine: its curator,
   *  or null when Kismet curates (Kismet's own referral then applies). */
  referral: string | null
  lineup: LineupRow[]
  waiting: number
  /** Who collected what through this machine lately. */
  recentWins: RecentWin[]
  /** Linked collections: new work minted into them joins by itself. */
  collections: string[]
}

export function RevealMachine({ id }: { id: string }) {
  const ensureConnected = useEnsureConnected()
  const { collect, status } = useDirectCollect()
  const ethUsd = useEthUsd()
  const { address } = useAccount()
  const [data, setData] = useState<Payload | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [pick, setPick] = useState<LineupRow | null>(null)
  // The pick is made; the capsule is still opening over it.
  const [opening, setOpening] = useState(false)
  const [collected, setCollected] = useState<string | null>(null)

  const load = useCallback(() => {
    fetch(`/api/experience/machines/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: Payload) => { setData(d); setLoadError(false) })
      .catch(() => setLoadError(true))
  }, [id])
  useEffect(load, [load])

  const pull = useCallback(() => {
    if (!data || data.lineup.length === 0) return
    setCollected(null)
    setPick(data.lineup[pickIndex(data.lineup.length)])
    setOpening(motionAllowed())
  }, [data])
  const endOpen = useCallback(() => revealAfterOpen(() => setOpening(false)), [])
  // The piece replaces the button that pulled it: focus moves to it rather
  // than falling to the page (WCAG 2.4.3).
  const pickRef = useRef<HTMLDivElement>(null)
  const showing = !!pick && !opening
  useEffect(() => {
    if (showing && document.activeElement === document.body) pickRef.current?.focus({ preventScroll: true })
  }, [showing, pick])

  const collecting = status !== 'idle' && status !== 'done' && status !== 'error'
  const collectPick = useCallback(async () => {
    if (!pick || collecting) return
    if (!(await ensureConnected())) return
    const done = await collect({
      collectionAddress: pick.collection as Address,
      tokenId: pick.tokenId,
      amount: 1,
      curator: data?.referral,
      machineId: id,
    })
    if (done) {
      setCollected(pick.key)
      // The piece may have just sold out; the lineup should say so.
      load()
    }
  }, [collect, collecting, data?.referral, ensureConnected, id, load, pick])

  // Every person the page names, by the platform's name standard.
  const nameOf = useProfileNames([
    data?.machine.creator,
    ...(data?.lineup ?? []).map((p) => p.artist),
    ...(data?.recentWins ?? []).map((w) => w.player),
  ])

  if (loadError) {
    return <p className="max-w-3xl mx-auto text-sm font-mono text-muted">This machine could not be loaded.</p>
  }
  if (!data) return <p className="max-w-3xl mx-auto text-sm font-mono text-subtle">loading…</p>

  const live = data.machine.state === 'live'
  const n = data.lineup.length
  // What the box says to a screen reader as it changes (WCAG 4.1.3).
  const announcement = !pick
    ? ''
    : opening
      ? 'Opening'
      : collected === pick.key
        ? `You've collected ${artworkTitle(pick.name, pick.tokenId)} by ${nameOf(pick.artist)}`
        : collecting
          ? 'Confirm in your wallet'
          : `You revealed ${artworkTitle(pick.name, pick.tokenId)} by ${nameOf(pick.artist)}`

  return (
    <div className="max-w-3xl mx-auto">
      <header className="mb-6">
        <h1 className="text-lg font-mono tracking-wider text-ink">{data.machine.name}</h1>
        <p className="text-[11px] font-mono text-muted mt-1">
          curated by {nameOf(data.machine.creator)} · pull for free, collect what you reveal at its price
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
        <MachineArtEditors machine={data.machine} kind="reveal" onDone={load} />
      </header>

      <div className="border border-line bg-surface p-6 sm:p-10 text-center">
        <p role="status" className="sr-only">{announcement}</p>
        <MachineStage
          stage={opening ? 'open' : pick ? null : 'idle'}
          cover={data.machine.cover}
          frames={data.machine.frames}
          onOpened={endOpen}
        />
        {pick && !opening ? (
          <div ref={pickRef} tabIndex={-1} className="outline-none">
            <p className="text-xs font-mono uppercase tracking-widest accent-grad">you revealed</p>
            <Link href={`/artwork/${pick.collection}/${pick.tokenId}`} className="group block mt-5">
              <div className="relative overflow-hidden border border-line bg-raised aspect-square max-w-[240px] mx-auto [view-transition-name:machine-window]">
                {pick.image ? (
                  <MomentImage src={pick.image} alt="" fill className="object-cover" sizes="240px" />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-subtle">
                    #{pick.tokenId}
                  </div>
                )}
              </div>
              {collected === pick.key ? (
                <div className="mt-3">
                  <CollectedLine title={artworkTitle(pick.name, pick.tokenId)} by={nameOf(pick.artist)} />
                </div>
              ) : (
                <>
                  <p className="mt-2 text-[11px] font-mono text-ink truncate group-hover:underline">
                    {artworkTitle(pick.name, pick.tokenId)}
                  </p>
                  <p className="text-[10px] font-mono text-muted truncate">by {nameOf(pick.artist)}</p>
                </>
              )}
            </Link>
            <div className="mt-5 flex flex-wrap gap-2 justify-center">
              {collected === pick.key && (
                <GachaponShareButton
                  share={{ machineId: id, collection: pick.collection, tokenId: pick.tokenId, title: pick.name, artist: pick.artist }}
                  className="px-6 py-3 text-xs font-mono tracking-widest uppercase btn-accent"
                />
              )}
              {collected !== pick.key && (
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
                paid to the artist through its own sale
                {pick.sale.currency === 'eth' && ethUsdApprox(pick.sale.pricePerToken, ethUsd) && (
                  <span className="text-subtle"> {ethUsdApprox(pick.sale.pricePerToken, ethUsd)}</span>
                )}
                <span className="text-subtle"> + network fee</span>
              </p>
            )}
          </div>
        ) : !opening && (
          <div>
            <p className="text-xs font-mono uppercase tracking-widest text-muted">
              {!live ? 'this machine is closed' : n === 0 ? 'nothing on sale right now' : 'free to pull'}
            </p>
            <button
              onClick={pull}
              disabled={!live || n === 0}
              className="mt-5 px-6 py-3 text-xs font-mono tracking-widest uppercase btn-accent disabled:opacity-40"
            >
              pull
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
                  <p className="text-[10px] font-mono text-subtle truncate">by {nameOf(p.artist)}</p>
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

      <RecentWins machineId={id} wins={data.recentWins ?? []} account={address?.toLowerCase() ?? null} nameOf={nameOf} />
    </div>
  )
}
