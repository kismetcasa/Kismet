'use client'

import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { Ellipsis } from 'lucide-react'
import { useEthUsd } from '@/hooks/useEthUsd'
import { useProfileNames } from '@/hooks/useProfileNames'
import { useUploadSession } from '@/hooks/useUploadSession'
import { formatPrice } from '@/lib/inprocess'
import { ethUsdApprox } from '@/lib/usdApprox'
import type { MachineCardData } from '@/lib/experience/cards'
import { CoverCard, CoverImage } from './CoverCard'
import { MachineAction } from './MachineAction'
import { GRID_CLASSES, SHOWCASE_ITEM_CLASSES, SHOWCASE_ROW_CLASSES } from './profileLayout'

// Its owner's alone, with the upload stack behind it, so a visitor's profile
// never loads it (as MachineArtEditors on a machine's page).
const CoverEditor = dynamic(() => import('./CoverField').then((m) => m.CoverEditor), { ssr: false })

/**
 * A creator's machines, capsule and reveal, on their profile, for two readers
 * who want different things.
 *
 * A visitor wants to know what they can play and what it costs. Each machine
 * is the play list's card (MachineCards) at the profile's scale for the view:
 * what a play costs, what is left, live machines first. Who won what, the
 * odds and the lineup are the machine page's, which a paid draw needs first.
 *
 * The owner wants to know what needs them and how each machine is doing.
 * Their dashboard lists every machine in every state as a row, the way it
 * lists their sales and airdrops: what needs them first, the state in plain
 * words, what sold and what it took in, and the rare actions (change the
 * cover, end a season or close a machine, withdraw) in a menu.
 *
 * Before this, publishing was the end of the trail: a machine sent to review
 * showed a confirmation and was never seen again — its page 404s until
 * approved, nothing listed it, and nothing told its creator whether it was
 * approved or turned down.
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
      /** Its capsule's supply as the chain has it: what is left, and what has
       *  sold anywhere (zora.co too). Null when it could not be read. */
      capsules: { maxSupply: number | null; minted: number } | null
      /** The price of a play while it is on sale (lib/experience/cards
       *  machinePrices); null otherwise. */
      price: MachineCardData['price']
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

type Machine = CreatorMachine

/** A machine has a page once it has been on the shelves: /play/[id] 404s a
 *  draft and one waiting for a curator. */
const pageOf = (m: Machine) => (m.state === 'draft' || m.state === 'review' ? undefined : `/play/${m.id}`)

const artworks = (n: number) => `${n} ${n === 1 ? 'artwork' : 'artworks'}`

/** What a machine took in, in each currency it was paid in; null for none. */
function takenIn(stats: Machine['stats']): string | null {
  if (!stats) return null
  const paid = [
    BigInt(stats.ethWei) > 0n ? formatPrice(stats.ethWei, 'eth') : null,
    BigInt(stats.usdcMicro) > 0n ? formatPrice(stats.usdcMicro, 'usdc') : null,
  ].filter(Boolean)
  return paid.length ? paid.join(' + ') : null
}

/** A card's type at each of the profile's densities, as MomentCard sizes its
 *  own: compact in the dense grid (the profile's collection cards), full in
 *  the showcase (the play list's cards, MachineCards). With the cover's width
 *  at each, for its `sizes` (MomentCard's). */
const DENSITY = {
  compact: {
    name: 'text-[11px]',
    state: 'text-[9px]',
    line: 'text-[10px]',
    button: 'py-1 text-[10px]',
    sizes: '(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 16vw',
  },
  full: {
    name: 'text-xs sm:text-sm',
    state: 'text-[9px] sm:text-[10px]',
    line: 'text-[10px] sm:text-[11px]',
    button: 'py-1.5 text-xs',
    sizes: '(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw',
  },
} as const
type Density = keyof typeof DENSITY

export function ProfileMachines({
  machines,
  manage,
  signedIn,
  referralPaid,
  featuredIn = [],
  layout = 'grid',
  onChange,
}: {
  machines: CreatorMachine[]
  /** The profile's layout for a visitor's view (./profileLayout): the dense
   *  grid of the full profile, or the curated showcase. The owner's own
   *  dashboard is always the list. */
  layout?: 'grid' | 'showcase'
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
  return (
    <div className="flex flex-col gap-3">
      {manage ? (
        <OwnerMachines machines={machines} signedIn={signedIn} referralPaid={referralPaid} onChange={onChange} />
      ) : layout === 'showcase' ? (
        <ShowcaseMachines machines={machines} />
      ) : (
        <GridMachines machines={machines} />
      )}
      {featuredIn.length > 0 && <FeaturedInList featuredIn={featuredIn} manage={manage} />}
      {manage && (
        <Link href="/play/create" className="self-start text-[11px] font-mono text-dim hover:text-ink underline mt-1">
          build another gachapon →
        </Link>
      )}
    </div>
  )
}

// ─── a visitor's cards ─────────────────────────────────────────────────────

/** What a visitor can play comes first; closed machines follow, each group
 *  in the order given (newest first). */
const liveFirst = (machines: Machine[]) =>
  [...machines].sort((a, b) => Number(b.state === 'live') - Number(a.state === 'live'))

function GridMachines({ machines }: { machines: Machine[] }) {
  if (machines.length === 0) return null
  return (
    <div className={GRID_CLASSES}>
      {liveFirst(machines).map((m) => (
        <MachineCard key={m.id} machine={m} density="compact" ethUsd={null} />
      ))}
    </div>
  )
}

/** The curated showcase: full-scale cards, with what a play costs in dollars
 *  beside its ETH, as the play list shows it. */
function ShowcaseMachines({ machines }: { machines: Machine[] }) {
  const ethUsd = useEthUsd()
  if (machines.length === 0) return null
  return (
    <div className={SHOWCASE_ROW_CLASSES}>
      {liveFirst(machines).map((m) => (
        <div key={m.id} className={SHOWCASE_ITEM_CLASSES}>
          <MachineCard machine={m} density="full" ethUsd={ethUsd} />
        </div>
      ))}
    </div>
  )
}

/**
 * One machine as a visitor reads it: what it costs and what is left, then one
 * way in. The play list's card (MachineCards) at the profile's density, with
 * a closed machine's cover quieter, since it can no longer be played.
 */
function MachineCard({ machine: m, density, ethUsd }: { machine: Machine; density: Density; ethUsd: number | null }) {
  const t = DENSITY[density]
  const href = pageOf(m)
  const live = m.state === 'live'
  const supply = availability(m, density === 'full')
  return (
    <CoverCard href={href} image={m.art?.image} thumbhash={m.art?.thumbhash} alt={m.name} sizes={t.sizes} muted={!live}>
      <div className="flex items-center gap-2">
        <h3 className={`flex-1 min-w-0 ${t.name} font-mono text-ink truncate`}>{m.name}</h3>
        <span className={`${t.state} font-mono uppercase tracking-wider shrink-0 ${live ? 'text-accent' : 'text-muted'}`}>
          {live ? 'live' : 'closed'}
        </span>
      </div>
      <p className={`${t.line} font-mono text-muted truncate`}>
        <CostLine machine={m} full={density === 'full'} ethUsd={ethUsd} />
      </p>
      {supply && <p className={`${t.line} font-mono text-muted tabular-nums`}>{supply}</p>}
      {href && (
        <Link
          href={href}
          className={`mt-auto w-full px-3 ${t.button} text-center font-mono border border-line text-dim hover:border-muted hover:text-ink transition-colors`}
        >
          {!live ? 'view' : m.kind === 'reveal' ? 'pull' : 'play'}
        </Link>
      )}
    </CoverCard>
  )
}

/** What playing costs, in the play list's words: the price of a play, or a
 *  free pull whose piece is collected at its own price. */
function CostLine({ machine: m, full, ethUsd }: { machine: Machine; full: boolean; ethUsd: number | null }) {
  if (m.kind === 'reveal') return <>{m.state === 'live' ? 'free to pull' : 'reveal machine'}</>
  if (m.state !== 'live') return <>capsule · season over</>
  if (!m.price) return <>capsule machine</>
  const usd = full && m.price.currency === 'eth' ? ethUsdApprox(m.price.pricePerToken, ethUsd) : null
  return (
    <>
      <span className="text-dim">{formatPrice(m.price.pricePerToken, m.price.currency)}</span> per play
      {usd && <span className="text-subtle"> {usd}</span>}
    </>
  )
}

/** What is left to have: capsules left to buy (sold out, or what sold, once
 *  it closes), or the artworks a reveal machine draws from. */
function availability(m: Machine, full: boolean): string | null {
  if (m.kind === 'reveal') return full ? `${artworks(m.pieces)} · each at its own price` : artworks(m.pieces)
  const c = m.capsules
  if (!c) return null
  if (c.maxSupply === null) return c.minted > 0 ? `${c.minted} sold` : null
  if (c.minted >= c.maxSupply) return 'sold out'
  return m.state === 'live' ? `${c.maxSupply - c.minted} of ${c.maxSupply} left` : `${c.minted} of ${c.maxSupply} sold`
}

// ─── the owner's list ──────────────────────────────────────────────────────

/** The order an owner reads them in: what needs them first, then what is on
 *  the shelves, then what has closed — each group in the order given. */
const OWNER_ORDER: Record<Machine['state'], number> = { draft: 0, delisted: 1, review: 2, live: 3, ended: 4 }
const needsYouFirst = (machines: Machine[]) => [...machines].sort((a, b) => OWNER_ORDER[a.state] - OWNER_ORDER[b.state])

/** Each state in the owner's summary, in reading order. */
const SUMMARY: [Machine['state'], (n: number) => string][] = [
  ['draft', (n) => `${n} not submitted`],
  ['delisted', (n) => `${n} delisted`],
  ['review', (n) => `${n} waiting for a curator`],
  ['live', (n) => `${n} live`],
  ['ended', (n) => `${n} closed`],
]

/** A state's pill: the play list's words for the shelves, and the states only
 *  an owner sees in colours of their own — the brand's orange while a curator
 *  decides, its coral once one has taken the machine down (the review queue's
 *  colour for a problem). */
const PILL: Record<Machine['state'], { label: string; className: string }> = {
  live: { label: 'live', className: 'text-accent bg-accent/10' },
  ended: { label: 'closed', className: 'text-muted border border-line' },
  review: { label: 'in review', className: 'text-[#ffb375] bg-[#ffb375]/10' },
  delisted: { label: 'delisted', className: 'text-[#ff7c80] bg-[#ff7c80]/10' },
  draft: { label: 'draft', className: 'text-muted border border-line' },
}

/** What an owner is told about a machine that needs them, in plain words. */
const ATTENTION: Partial<Record<Machine['state'], { text: string; className: string }>> = {
  draft: { text: 'The publish didn’t finish · withdraw it to fix and publish again', className: 'text-dim' },
  review: { text: 'Waiting for a curator', className: 'text-[#ffb375]' },
  delisted: { text: 'Delisted by a curator', className: 'text-[#ff7c80]' },
}

function OwnerMachines({
  machines,
  signedIn,
  referralPaid,
  onChange,
}: {
  machines: Machine[]
  signedIn: boolean
  referralPaid?: string | null
  onChange: () => void
}) {
  const { ensureSession } = useUploadSession()
  const counts = new Map<Machine['state'], number>()
  for (const m of machines) counts.set(m.state, (counts.get(m.state) ?? 0) + 1)
  // What the capsule machines took in, together; a reveal machine's collects
  // pay their artists, so they are not the owner's to count here.
  const wei = machines.reduce((n, m) => (m.kind === 'capsule' && m.stats ? n + BigInt(m.stats.ethWei) : n), 0n)
  const usdc = machines.reduce((n, m) => (m.kind === 'capsule' && m.stats ? n + BigInt(m.stats.usdcMicro) : n), 0n)
  const money = [wei > 0n ? formatPrice(wei.toString(), 'eth') : null, usdc > 0n ? formatPrice(usdc.toString(), 'usdc') : null]
    .filter(Boolean)
    .join(' + ')
  const summary = SUMMARY.flatMap(([state, say]) => {
    const n = counts.get(state)
    return n ? [say(n)] : []
  })
  if (money) summary.push(`${money} taken in by capsules`)
  return (
    <>
      {!signedIn && (
        <button
          onClick={() => void ensureSession({ revalidate: true }).then(onChange).catch(() => {})}
          className="self-start text-[11px] font-mono text-dim hover:text-ink underline"
        >
          sign in to see every machine, including any waiting for review, with what each sold and its actions
        </button>
      )}
      {signedIn && referralPaid != null && (
        <p className="text-[11px] font-mono text-muted leading-relaxed">
          Collects through your reveal machines earn you Zora&apos;s mint referral, paid to your wallet
          automatically each day.{' '}
          <span className="text-dim">Paid so far: {/^0*$/.test(referralPaid) ? '0 ETH' : formatPrice(referralPaid, 'eth')}</span>
        </p>
      )}
      {summary.length > 0 && <p className="text-[11px] font-mono text-dim tabular-nums">{summary.join(' · ')}</p>}
      {machines.length > 0 && (
        <ul className="border border-line divide-y divide-line" aria-label="Your machines">
          {needsYouFirst(machines).map((m) => (
            <OwnerRow key={m.id} machine={m} signedIn={signedIn} onChange={onChange} />
          ))}
        </ul>
      )}
      {signedIn && machines.some((m) => m.kind === 'capsule' && (m.stats?.plays ?? 0) > 0) && (
        <p className="text-[10px] font-mono text-subtle leading-relaxed">
          Capsule prizes are minted by Kismet when a paid capsule is opened. They are not airdrops: they
          don&apos;t appear in your airdrops or count toward your airdrop allowance.
        </p>
      )}
    </>
  )
}

/**
 * One machine as its owner manages it: the state first, what sold and what it
 * took in, and the actions behind one menu. A confirmation (end, close,
 * withdraw) and a picked cover each open in the row, under it.
 */
function OwnerRow({ machine: m, signedIn, onChange }: { machine: Machine; signedIn: boolean; onChange: () => void }) {
  const href = pageOf(m)
  // A cover picked but not yet saved shows in the row's thumbnail too.
  const [preview, setPreview] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'end' | 'withdraw' | null>(null)
  const openCover = useRef<(() => void) | null>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  const actions: MenuAction[] = []
  if (signedIn) {
    // Any machine past a draft. For one waiting on a curator this is the only
    // way, since its page does not exist yet.
    if (m.state !== 'draft') actions.push({ label: 'Change cover', run: () => openCover.current?.() })
    if (m.state === 'live') {
      actions.push({ label: m.kind === 'reveal' ? 'Close machine' : 'End season', run: () => setConfirm('end'), danger: true })
    }
    if (m.withdrawable) actions.push({ label: 'Withdraw', run: () => setConfirm('withdraw'), danger: true })
  }
  const attention = ATTENTION[m.state]
  const figures = ownerFigures(m)
  return (
    <li className="px-3 py-2.5">
      <div className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] sm:grid-cols-[2.5rem_minmax(0,1fr)_minmax(0,18rem)_auto] items-center gap-x-3 gap-y-1">
        <MachineThumb href={href} image={preview ?? m.art?.image} thumbhash={preview ? undefined : m.art?.thumbhash} />
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="min-w-0 truncate text-xs font-mono text-ink">{m.name}</span>
            <span className={`shrink-0 px-1.5 py-px text-[9px] font-mono uppercase tracking-wider ${PILL[m.state].className}`}>
              {PILL[m.state].label}
            </span>
          </div>
          <p className="text-[10px] font-mono text-muted truncate">{kindLine(m)}</p>
        </div>
        {(attention || figures.length > 0) && (
          <div className="col-span-2 col-start-2 row-start-2 sm:col-span-1 sm:col-start-auto sm:row-start-auto min-w-0 text-[11px] font-mono text-dim tabular-nums leading-relaxed sm:text-right">
            {attention && <p className={attention.className}>{attention.text}</p>}
            {figures}
          </div>
        )}
        <div className="col-start-3 row-start-1 sm:col-start-4 flex items-center justify-end gap-2">
          {href && (
            <Link
              href={href}
              className="px-2.5 py-1 text-[10px] font-mono border border-line text-dim hover:border-muted hover:text-ink transition-colors"
            >
              view
            </Link>
          )}
          {actions.length > 0 && <ActionsMenu label={`More actions for ${m.name}`} actions={actions} buttonRef={menuButton} />}
        </div>
      </div>
      {signedIn && m.state !== 'draft' && (
        <CoverEditor
          variant="menu"
          openRef={openCover}
          machineId={m.id}
          current={m.cover}
          onDone={onChange}
          onPick={setPreview}
          className="mt-2 flex flex-wrap items-center gap-3 border-t border-line pt-2"
        />
      )}
      {confirm && (
        <MachineAction
          machine={m}
          action={confirm}
          confirmOnly
          onDone={() => {
            setConfirm(null)
            onChange()
          }}
          onCancel={() => {
            setConfirm(null)
            menuButton.current?.focus()
          }}
          panelClassName="mt-2 border-t border-line pt-2"
        />
      )}
    </li>
  )
}

/** What kind of machine it is, and what a play costs while it is on sale. */
function kindLine(m: Machine): string {
  if (m.kind === 'reveal') return `reveal · ${artworks(m.pieces)}`
  return m.price ? `capsule · ${formatPrice(m.price.pricePerToken, m.price.currency)} per play` : 'capsule'
}

/**
 * An owner's figures for a machine that has been on the shelves. A capsule
 * machine's sales are the chain's count — every capsule bought, here or on
 * zora.co — out of its supply, so what sold and what is left always agree;
 * what it took in is what came through Kismet. A reveal machine's collects
 * pay their artists, so the owner sees how many, not the money.
 */
function ownerFigures(m: Machine): ReactNode[] {
  if (m.state === 'draft' || m.state === 'review') return []
  if (m.kind === 'reveal') {
    return m.stats ? [<p key="collects">{m.stats.collects} collected</p>] : []
  }
  const out: ReactNode[] = []
  const c = m.capsules
  // Every capsule Kismet recorded as sold was minted, so the chain has at
  // least that many: a read that lags never shows fewer sold than were.
  const minted = c ? Math.max(c.minted, m.stats?.plays ?? 0) : null
  const sold =
    c && minted !== null
      ? c.maxSupply === null
        ? `${minted} sold`
        : minted >= c.maxSupply
          ? `all ${c.maxSupply} sold`
          : `${minted} of ${c.maxSupply} sold`
      : m.stats
        ? `${m.stats.plays} sold`
        : null
  if (sold) out.push(<p key="sold">{sold}</p>)
  const money = takenIn(m.stats)
  if (money) out.push(<p key="money">{money} taken in</p>)
  if (m.state !== 'live') out.push(<p key="honoured" className="text-muted">capsules sold are still honoured</p>)
  return out
}

/** A row's cover, small; the row's own link and menu carry it for a keyboard. */
function MachineThumb({ href, image, thumbhash }: { href?: string; image: string | null | undefined; thumbhash?: string }) {
  const box = 'relative block w-10 h-10 shrink-0 overflow-hidden border border-line bg-raised'
  const img = <CoverImage image={image} thumbhash={thumbhash} alt="" sizes="40px" className="object-cover" fallback={null} />
  return href ? (
    <Link href={href} className={box} tabIndex={-1} aria-hidden="true">
      {img}
    </Link>
  ) : (
    <div className={box}>{img}</div>
  )
}

interface MenuAction {
  label: string
  run: () => void
  /** Ends or takes something back: drawn in the review queue's problem colour. */
  danger?: boolean
}

/**
 * The row's actions behind one button, built like the nav's menu: a button
 * that says it opens a menu, and the menu under it. Arrow keys move through
 * it, Escape closes it and gives focus back to the button, and a tap outside
 * closes it. An action runs inside the tap that chose it, which is what lets
 * "Change cover" open the file picker.
 */
function ActionsMenu({ label, actions, buttonRef }: { label: string; actions: MenuAction[]; buttonRef: RefObject<HTMLButtonElement | null> }) {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const wrap = useRef<HTMLDivElement>(null)
  const items = useRef<(HTMLButtonElement | null)[]>([])
  const close = useCallback(() => {
    setOpen(false)
    buttonRef.current?.focus()
  }, [buttonRef])
  useEffect(() => {
    if (open) items.current[0]?.focus()
  }, [open])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
    }
  }, [open])
  const move = (by: number | 'first' | 'last') => {
    const n = actions.length
    const at = items.current.findIndex((el) => el === document.activeElement)
    const next = by === 'first' ? 0 : by === 'last' ? n - 1 : (at + by + n) % n
    items.current[next]?.focus()
  }
  return (
    <div
      ref={wrap}
      className="relative"
      onKeyDown={(e) => {
        if (!open) return
        if (e.key === 'Escape') {
          e.preventDefault()
          close()
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          move(1)
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          move(-1)
        } else if (e.key === 'Home') {
          e.preventDefault()
          move('first')
        } else if (e.key === 'End') {
          e.preventDefault()
          move('last')
        } else if (e.key === 'Tab') {
          setOpen(false)
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            setOpen(true)
          }
        }}
        className="flex items-center justify-center w-8 h-8 border border-line text-dim hover:border-muted hover:text-ink transition-colors"
      >
        <Ellipsis size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className="absolute right-0 top-full mt-1 min-w-[10rem] border border-line bg-[#0d0d0d]/95 z-[60] flex flex-col"
        >
          {actions.map((a, i) => (
            <button
              key={a.label}
              ref={(el) => {
                items.current[i] = el
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                setOpen(false)
                a.run()
              }}
              className={`px-3 py-2 text-left text-xs font-mono tracking-wider uppercase hover:bg-[#1e1e1e] focus:bg-[#1e1e1e] focus:outline-none transition-colors ${
                a.danger ? 'text-[#ff7c80]' : 'text-dim hover:text-ink focus:text-ink'
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── featured in ───────────────────────────────────────────────────────────

/** Other curators' reveal machines with this person's work in them. */
function FeaturedInList({ featuredIn, manage }: { featuredIn: FeaturedIn[]; manage: boolean }) {
  const nameOf = useProfileNames(featuredIn.map((f) => f.curator))
  return (
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
  )
}
