'use client'

import { useCallback, useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useProfileNames } from '@/hooks/useProfileNames'
import { useUploadSession } from '@/hooks/useUploadSession'
import { formatPrice } from '@/lib/inprocess'
import type { MachineCardData } from '@/lib/experience/cards'
import { CoverCard } from './CoverCard'
import { MachineAction } from './MachineAction'

// Its owner's alone, with the upload stack behind it, so a visitor's profile
// never loads it (as MachineArtEditors on a machine's page).
const CoverEditor = dynamic(() => import('./CoverField').then((m) => m.CoverEditor), { ssr: false })

/**
 * A creator's machines, capsule and reveal, on their profile.
 *
 * Before this, publishing was the end of the trail: a machine sent to review
 * showed a confirmation and was never seen again — its page 404s until
 * approved, nothing listed it, and nothing told its creator whether it was
 * approved or turned down. Visitors now see the machines on sale; the creator
 * sees every state, in plain words, with the two things they can do about it:
 * end a season, and withdraw a machine that has never been on sale.
 */

interface CreatorMachineCommon {
  id: string
  name: string
  state: 'draft' | 'review' | 'live' | 'ended' | 'delisted'
  createdAt: number
  /** Present only in the creator's own view. */
  withdrawable?: boolean
  /** Its cover, an ar:// upload; null for a machine published before covers. */
  cover: string | null
  /** What its card shows (lib/experience/cards): the cover, or — for a
   *  machine published before covers — art it already has. */
  art: MachineCardData['cover']
  /** Its creator's view only: what it has done since it was first counted. */
  stats?: { plays: number; collects: number; ethWei: string; usdcMicro: string } | null
}

export type CreatorMachine =
  | (CreatorMachineCommon & {
      kind: 'capsule'
      capsule: { collection: string; tokenId: string }
      plays: number
      capsules: { maxSupply: number | null; minted: number } | null
      /** Prizes delivered, and the latest few — minted by Kismet when a
       *  capsule is opened. Not airdrops, and never in the airdrops list. */
      prizes: { count: number; recent: { player: string; collection: string; tokenId: string; txHash: string; unitIndex: number }[] }
    })
  | (CreatorMachineCommon & { kind: 'reveal'; pieces: number })

/** A reveal machine curated by someone else that features this person's work. */
export interface FeaturedIn {
  id: string
  name: string
  state: string
  curator: string
  pieces: { collection: string; tokenId: string }[]
}

/** Loaded once by the profile, which shows the section only when there is
 *  something in it. `owner` is the SERVER's verdict — true only when the
 *  signed-in session is this creator, which is what gates non-public states. */
export function useCreatorMachines(address: string) {
  const [machines, setMachines] = useState<CreatorMachine[]>([])
  const [owner, setOwner] = useState(false)
  /** Wei of referral rewards confirmed paid to a curator; owner view only. */
  const [referralPaid, setReferralPaid] = useState<string | null>(null)
  const [featuredIn, setFeaturedIn] = useState<FeaturedIn[]>([])
  const reload = useCallback(() => {
    fetch(`/api/experience/machines?creator=${address}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { owner: boolean; machines: CreatorMachine[]; referralPaid?: string; featuredIn?: FeaturedIn[] } | null) => {
        setMachines(d?.machines ?? [])
        setOwner(d?.owner === true)
        setReferralPaid(d?.referralPaid ?? null)
        setFeaturedIn(d?.featuredIn ?? [])
      })
      .catch(() => {})
  }, [address])
  useEffect(() => {
    setMachines([])
    setOwner(false)
    setReferralPaid(null)
    setFeaturedIn([])
    reload()
  }, [reload])
  return { machines, owner, referralPaid, featuredIn, reload }
}

const isPublic = (m: CreatorMachine) => m.state === 'live' || m.state === 'ended'

export function publicMachines(machines: CreatorMachine[]): CreatorMachine[] {
  return machines.filter(isPublic)
}

const STATUS: Record<CreatorMachine['state'], string> = {
  live: 'on sale',
  ended: 'season ended · capsules already sold are still honoured',
  review: 'waiting for a curator',
  delisted: 'delisted by a curator · capsules already sold are still honoured',
  draft: 'not submitted — the publish did not finish',
}

/** A reveal machine sells nothing, so nothing is owed when it closes. */
const REVEAL_STATUS: Record<CreatorMachine['state'], string> = {
  ...STATUS,
  live: 'open',
  ended: 'closed',
  delisted: 'delisted by a curator',
}

/** The profile's card grid, at the density its collections and mints use
 *  (ProfileView's GRID_CLASSES, PaginatedGrid's grid view): two to a row on a
 *  phone, six on a wide screen. */
const GRID_CLASSES = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3'
/** A cover's width at that density — the profile's collection covers' sizes. */
const COVER_SIZES = '(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 16vw'

export function ProfileMachines({
  machines,
  manage,
  signedIn,
  referralPaid,
  featuredIn = [],
  onChange,
}: {
  machines: CreatorMachine[]
  /** Other people's reveal machines featuring this person's work. */
  featuredIn?: FeaturedIn[]
  /** Owner view of a curator: referral rewards confirmed paid, in wei. */
  referralPaid?: string | null
  /** The profile belongs to the connected wallet. */
  manage: boolean
  /** The server recognised the session as this creator's. */
  signedIn: boolean
  onChange: () => void
}) {
  const { ensureSession } = useUploadSession()
  const nameOf = useProfileNames([
    ...machines.flatMap((m) => (m.kind === 'capsule' ? m.prizes.recent.map((p) => p.player) : [])),
    ...featuredIn.map((f) => f.curator),
  ])
  const own = manage && signedIn

  return (
    <div className="flex flex-col gap-3">
      {own && referralPaid != null && (
        <p className="text-[11px] font-mono text-muted leading-relaxed">
          Collects through your reveal machines earn you Zora&apos;s mint referral, paid to your wallet
          automatically each day.{' '}
          <span className="text-dim">Paid so far: {/^0*$/.test(referralPaid) ? '0 ETH' : formatPrice(referralPaid, 'eth')}</span>
        </p>
      )}
      {manage && !signedIn && (
        <button
          onClick={() => void ensureSession({ revalidate: true }).then(onChange).catch(() => {})}
          className="self-start text-[11px] font-mono text-dim hover:text-ink underline"
        >
          sign in to see machines waiting for review
        </button>
      )}
      {machines.length > 0 && (
        <div className={GRID_CLASSES}>
          {machines.map((m) => (
            <MachineCard key={m.id} machine={m} own={own} signedIn={signedIn} nameOf={nameOf} onChange={onChange} />
          ))}
        </div>
      )}
      {own && machines.some((m) => m.kind === 'capsule' && m.prizes.recent.length > 0) && (
        <p className="text-[10px] font-mono text-subtle leading-relaxed">
          Capsule prizes are minted by Kismet when a paid capsule is opened. They are not airdrops: they
          don&apos;t appear in your airdrops or count toward your airdrop allowance.
        </p>
      )}
      {featuredIn.length > 0 && (
        <div className="mt-2">
          <p className="text-[10px] font-mono uppercase tracking-widest text-muted mb-1.5">
            {manage ? 'your work in other machines' : 'featured in'}
          </p>
          <ul className="flex flex-col gap-1">
            {featuredIn.map((f) => (
              <li key={f.id} className="text-[11px] font-mono text-subtle">
                <Link href={`/play/${f.id}`} className="text-dim hover:text-ink underline">
                  {f.name}
                </Link>{' '}
                · curated by{' '}
                <Link href={`/profile/${f.curator}`} className="hover:text-dim">
                  {nameOf(f.curator)}
                </Link>
                {f.state !== 'live' && ' · closed'}
                {' · '}
                {f.pieces.map((p, i) => (
                  <span key={`${p.collection}:${p.tokenId}`}>
                    {i > 0 && ', '}
                    <Link href={`/artwork/${p.collection}/${p.tokenId}`} className="hover:text-dim">
                      #{p.tokenId}
                    </Link>
                  </span>
                ))}
              </li>
            ))}
          </ul>
          {manage && (
            <p className="text-[10px] font-mono text-subtle mt-1 leading-relaxed">
              Curators can feature any of your pieces. To take one out of every reveal machine, turn machines off
              from that piece&apos;s page.
            </p>
          )}
        </div>
      )}
      {manage && (
        <Link href="/play/create" className="self-start text-[11px] font-mono text-dim hover:text-ink underline mt-1">
          build another gachapon →
        </Link>
      )}
    </div>
  )
}

/**
 * One machine as its card in the play list shows it (MachineCards), at the
 * profile's density — and, for its creator, its standing in plain words, its
 * figures, and the controls on it.
 */
function MachineCard({
  machine: m,
  own,
  signedIn,
  nameOf,
  onChange,
}: {
  machine: CreatorMachine
  /** The viewer is its creator, signed in: figures and controls. */
  own: boolean
  signedIn: boolean
  nameOf: (address: string) => string
  onChange: () => void
}) {
  // A draft, or a machine waiting for a curator, has no page yet (/play/[id]).
  const href = m.state !== 'draft' && m.state !== 'review' ? `/play/${m.id}` : undefined
  // A cover picked but not yet saved shows on the card itself, where it will go.
  const [preview, setPreview] = useState<string | null>(null)
  return (
    <CoverCard
      href={href}
      image={preview ?? m.art?.image}
      thumbhash={preview ? undefined : m.art?.thumbhash}
      alt={m.name}
      sizes={COVER_SIZES}
    >
      <div className="flex items-center gap-2">
        <h3 className="flex-1 min-w-0 text-[11px] font-mono text-ink truncate">
          {href ? (
            <Link href={href} className="hover:underline">
              {m.name}
            </Link>
          ) : (
            m.name
          )}
        </h3>
        <span
          className={`text-[9px] font-mono uppercase tracking-wider shrink-0 ${
            m.state === 'live' ? 'text-accent' : 'text-subtle'
          }`}
        >
          {m.state}
        </span>
      </div>
      <p className="text-[10px] font-mono text-muted leading-relaxed">
        {signedIn ? `${(m.kind === 'reveal' ? REVEAL_STATUS : STATUS)[m.state]} · ` : ''}
        {m.kind === 'reveal' ? (
          <>reveal machine · {m.pieces} {m.pieces === 1 ? 'artwork' : 'artworks'}</>
        ) : (
          <>
            {m.plays} {m.plays === 1 ? 'play' : 'plays'}
            {m.capsules && (
              <> · {m.capsules.minted}{m.capsules.maxSupply === null ? '' : ` of ${m.capsules.maxSupply}`} capsules minted</>
            )}
            {' · '}{m.prizes.count} {m.prizes.count === 1 ? 'prize' : 'prizes'} delivered
          </>
        )}
      </p>
      {m.stats && <MachineFigures kind={m.kind} stats={m.stats} />}
      {m.kind === 'capsule' && m.prizes.recent.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {m.prizes.recent.map((p) => (
            <li key={`${p.txHash}:${p.unitIndex}`} className="text-[10px] font-mono text-subtle truncate">
              <Link href={`/artwork/${p.collection}/${p.tokenId}`} className="text-dim hover:text-ink underline">
                #{p.tokenId}
              </Link>{' '}
              won by{' '}
              <Link href={`/profile/${p.player}`} className="hover:text-dim">
                {nameOf(p.player)}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-auto flex flex-col gap-2">
        {href && (
          <Link
            href={href}
            className="w-full px-3 py-1 text-center text-[10px] font-mono border border-line text-dim hover:border-muted hover:text-ink transition-colors"
          >
            {m.state !== 'live' ? 'view' : m.kind === 'reveal' ? 'pull' : 'play'}
          </Link>
        )}
        {own && (m.state === 'live' || m.withdrawable) && (
          <MachineAction
            machine={m}
            action={m.state === 'live' ? 'end' : 'withdraw'}
            onDone={onChange}
            triggerClassName="self-start text-[11px] font-mono text-dim hover:text-ink underline"
            panelClassName="border-t border-line pt-2"
          />
        )}
        {own && m.state !== 'draft' && (
          <CoverEditor
            machineId={m.id}
            current={m.cover}
            onDone={onChange}
            onPick={setPreview}
            className="flex flex-wrap items-center gap-2"
          />
        )}
      </div>
    </CoverCard>
  )
}

/** A machine's figures, for its creator: what came through it and what it took
 *  in, in each currency it was paid in. */
function MachineFigures({ kind, stats }: { kind: 'capsule' | 'reveal'; stats: NonNullable<CreatorMachineCommon['stats']> }) {
  const taken = [
    BigInt(stats.ethWei) > 0n ? formatPrice(stats.ethWei, 'eth') : null,
    BigInt(stats.usdcMicro) > 0n ? formatPrice(stats.usdcMicro, 'usdc') : null,
  ].filter(Boolean)
  const count = kind === 'capsule' ? stats.plays : stats.collects
  if (count === 0 && taken.length === 0) return null
  return (
    <p className="text-[10px] font-mono text-dim">
      {count} {kind === 'capsule' ? (count === 1 ? 'capsule sold' : 'capsules sold') : count === 1 ? 'piece collected through it' : 'pieces collected through it'}
      {taken.length > 0 && <> · {taken.join(' + ')} taken in</>}
    </p>
  )
}
