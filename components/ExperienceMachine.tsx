'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useDirectCollect } from '@/hooks/useDirectCollect'
import { useEnsureConnected } from '@/hooks/useEnsureConnected'
import { shortAddress } from '@/lib/inprocess'
import { MomentImage } from './MomentImage'
import {
  artworkTitle,
  formatOddsRatio,
  formatProbability,
  formatRemaining,
} from '@/lib/experience/format'
import {
  clearPendingCapsule,
  listPendingCapsules,
  rememberCapsule,
  type PendingCapsule,
} from '@/lib/experience/pendingCapsules'

/**
 * A capsule machine, end to end: the lineup, the odds, the play, the reveal,
 * and the recovery for anything that did not finish.
 *
 * ── The structural rule this component exists to enforce ──
 *
 * THE PLAY BUTTON AND THE ODDS TABLE ARE ONE COMPONENT, fed by one payload. If
 * the odds have not loaded, there is no button to press. That is deliberate:
 * Apple's Guideline 3.1.1 requires odds disclosure before a randomized
 * purchase, and Guideline 4.7 (extended to HTML5/JS mini apps in November 2025)
 * makes the native host responsible for embedded software — so as a Farcaster
 * Mini App a play we allowed without disclosure is a rejection risk for the
 * HOST. Making the two inseparable in one render makes the violation impossible
 * rather than merely policed.
 *
 * ── Nothing paid for is ever lost by this component ──
 *
 * The capsule transaction is written to local storage the instant it lands, and
 * the server's own claim list is fetched on mount. Between them, a player who
 * closes the tab mid-reveal, switches device, or hits a delivery failure always
 * has a route back to the artwork they are owed — see the "still opening"
 * section. Before this existed, a pending result was a dead end with no button.
 */

interface OddsRow {
  key: string
  collection: string
  tokenId: string
  artist: string
  probability: number
  remaining: number | null
  name: string | null
  image: string | null
}

interface Fairness {
  epoch: string
  commitment: string
  next: { epoch: string; commitment: string }
}

interface MachinePayload {
  machine: {
    id: string
    name: string
    state: string
    creator: string
    capsule: { collection: string; tokenId: string }
    capsuleArt: { name: string | null; image: string | null } | null
    splitRecipients: string[]
  }
  odds: OddsRow[]
  coverage: { capsulesOutstanding: number | null; prizesRemaining: number | null; covered: boolean }
  fairness: Fairness | null
  recentPlays: { player: string; txHash: string }[]
}

interface DiscoveredCapsule {
  txHash: string
  units: number
  owedUnits: number[]
}

interface ClaimRow {
  txHash: string
  unitIndex: number
  state: string
  unresolved: boolean
  prize: { collection: string; tokenId: string; artist: string } | null
  pendingReason: string | null
  createdAt: number
}

type Phase = 'idle' | 'paying' | 'opening' | 'won' | 'pending'

interface Prize {
  collection: string
  tokenId: string
  artist: string
  name?: string | null
  image?: string | null
}

/** Multi-pull sizes. A single and a ten are the gacha convention, and ten is
 *  also where the per-play round trip starts to dominate; a size selector is
 *  worth more than an arbitrary free-entry number a player would have to think
 *  about. */
const PULL_SIZES = [1, 5, 10] as const

export function ExperienceMachine({ id }: { id: string }) {
  const ensureConnected = useEnsureConnected()
  const { collect } = useDirectCollect()

  const [data, setData] = useState<MachinePayload | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [pull, setPull] = useState<number>(1)
  const [won, setWon] = useState<Prize[]>([])
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [pendingReason, setPendingReason] = useState<string | null>(null)
  const [lastTx, setLastTx] = useState<string | null>(null)
  const [account, setAccount] = useState<string | null>(null)
  const [claims, setClaims] = useState<ClaimRow[]>([])
  const [spark, setSpark] = useState(0)
  const [local, setLocal] = useState<PendingCapsule[]>([])
  const [discovered, setDiscovered] = useState<DiscoveredCapsule[]>([])
  const [redeemHash, setRedeemHash] = useState('')
  const [resuming, setResuming] = useState<string | null>(null)
  // Guards against a second play being dispatched while one is mid-flight —
  // the reveal keeps the button mounted, and a double tap would pay twice.
  const inFlight = useRef(false)

  const load = useCallback(() => {
    fetch(`/api/experience/machines/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: MachinePayload) => setData(d))
      .catch(() => setLoadError(true))
  }, [id])

  const loadClaims = useCallback(
    (addr: string) => {
      fetch(`/api/experience/claims?machineId=${id}&account=${addr}`)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d: { claims: ClaimRow[]; spark: number }) => {
          setClaims(d.claims ?? [])
          setSpark(d.spark ?? 0)
        })
        .catch(() => {})
    },
    [id],
  )

  // The chain-side recovery net: every capsule mint of this machine's token to
  // this player, read from TransferSingle logs server-side — which is what
  // makes a capsule minted on zora.co (or on another device) show up here with
  // no record of ours involved at all.
  const loadDiscovered = useCallback(
    (addr: string) => {
      fetch(`/api/experience/discover?machineId=${id}&account=${addr}`)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d: { capsules: DiscoveredCapsule[] }) => setDiscovered(d.capsules ?? []))
        .catch(() => {})
    },
    [id],
  )

  useEffect(() => { load() }, [load])
  useEffect(() => { setLocal(listPendingCapsules(id)) }, [id])
  useEffect(() => {
    if (!account) return
    loadClaims(account)
    loadDiscovered(account)
  }, [account, loadClaims, loadDiscovered])

  /** Open one already-paid unit. Shared by the fresh-play loop and by the
   *  recovery buttons, so a resumed capsule takes exactly the path a live one
   *  does and the two cannot drift. */
  const openUnit = useCallback(
    async (
      txHash: string,
      unitIndex: number,
      addr: string,
    ): Promise<{ prize: Prize | null; units: number | null }> => {
      const r = await fetch('/api/experience/play', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ machineId: id, txHash, account: addr, unitIndex }),
      })
      const body = await r.json().catch(() => null)
      if (!r.ok || !body?.ok) return { prize: null, units: null }
      // `units` is the on-chain quantity the server proved for the WHOLE
      // transaction — the only way to know how many plays a pasted or
      // discovered hash covers.
      const units = Number.isInteger(body.units) ? (body.units as number) : null
      if (body.claim?.state === 'delivered' && body.claim.prize) {
        return { prize: body.claim.prize as Prize, units }
      }
      if (body.claim?.pendingReason) setPendingReason(body.claim.pendingReason)
      return { prize: null, units }
    },
    [id],
  )

  const play = useCallback(async () => {
    if (!data || inFlight.current) return
    // Authoritative — reflects a wallet connected during this very tap, which
    // useAccount()'s render-scoped value would not yet show.
    const addr = await ensureConnected()
    if (!addr) return
    setAccount(addr)

    inFlight.current = true
    setPhase('paying')
    setWon([])
    setPendingReason(null)
    setProgress(null)

    try {
      // Paying IS collecting the capsule — the same wallet path, the same toast
      // sequence, the same splits paying every pool artist at this instant. A
      // multi-pull is ONE transaction for N capsules, so the player signs once.
      const res = await collect({
        collectionAddress: data.machine.capsule.collection as `0x${string}`,
        tokenId: data.machine.capsule.tokenId,
        amount: pull,
      })
      if (!res) { setPhase('idle'); return }

      // Written BEFORE the first open. This is the only record that survives the
      // tab closing between the mint landing and the server recording a claim,
      // and without it those capsules would be unreachable: /api/experience/play
      // needs the transaction hash and nothing on the server has seen it yet.
      rememberCapsule(id, { txHash: res.hash, units: pull, at: Date.now() })
      setLocal(listPendingCapsules(id))
      setLastTx(res.hash)

      setPhase('opening')
      // Sequential, not parallel: each unit is its own claim and its own draw,
      // and revealing them one at a time is both the correct pacing and what
      // keeps a ten-pull from firing ten concurrent sponsored mints.
      const prizes: Prize[] = []
      for (let unit = 0; unit < pull; unit++) {
        setProgress({ done: unit, total: pull })
        const opened = await openUnit(res.hash, unit, addr).catch(() => null)
        if (opened?.prize) { prizes.push(opened.prize); setWon([...prizes]) }
      }
      setProgress(null)

      if (prizes.length === pull) clearPendingCapsule(id, res.hash)
      setLocal(listPendingCapsules(id))

      if (prizes.length > 0) {
        setPhase('won')
        if (prizes.length < pull) {
          setPendingReason(
            `${pull - prizes.length} of ${pull} are still on their way — they are safe and will be honoured.`,
          )
        }
      } else {
        setPhase('pending')
        setPendingReason((r) => r ?? 'Your artwork is on its way.')
      }
    } catch {
      setPhase('pending')
      setPendingReason('Your capsule is paid for and safe. Reload to see your artwork.')
    } finally {
      inFlight.current = false
      load()
      if (addr) loadClaims(addr)
    }
  }, [collect, data, ensureConnected, id, load, loadClaims, openUnit, pull])

  /** Finish capsules that stalled.
   *
   *  Two steps per unit, in this order. The play route first: it replays
   *  idempotently and returns the RECORDED outcome, so a unit that was never
   *  claimed at all gets drawn and a unit already delivered just reports itself.
   *  Then the resume route, which is the only one that can re-attempt a delivery
   *  that failed — and which reconciles against the chain before it ever mints.
   *
   *  `units` matters: a multi-pull is one transaction for N capsules, so a tab
   *  closed mid-reveal can leave several owed under one hash. Resuming only unit
   *  0 would silently strand the rest. */
  const resume = useCallback(
    async (txHash: string, unitList: number[] | 'probe') => {
      const addr = account ?? (await ensureConnected())
      if (!addr) return
      setAccount(addr)
      const tag = `${txHash}:${unitList === 'probe' ? 'probe' : unitList[0] ?? 0}`
      setResuming(tag)
      const recovered: Prize[] = []
      let reason: string | null = null
      try {
        // 'probe' is the pasted-hash path: nothing local knows how many plays
        // the transaction covers, so open unit 0 first and let the server's
        // on-chain proof report the total, then open the rest.
        let units: number[]
        if (unitList === 'probe') {
          const first = await openUnit(txHash, 0, addr).catch(() => null)
          if (!first) {
            setPhase('pending')
            setPendingReason('That transaction could not be verified as a capsule for this machine.')
            return
          }
          if (first.prize) recovered.push(first.prize)
          const total = Math.min(first.units ?? 1, 20)
          units = Array.from({ length: Math.max(0, total - 1) }, (_, i) => i + 1)
        } else {
          units = unitList
        }

        for (const unit of units) {
          const opened = await openUnit(txHash, unit, addr).catch(() => null)
          if (opened?.prize) { recovered.push(opened.prize); continue }
          const r = await fetch('/api/experience/resume', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ machineId: id, txHash, unitIndex: unit }),
          })
          const body = await r.json().catch(() => null)
          if (body?.claim?.state === 'delivered' && body.claim.prize) {
            recovered.push(body.claim.prize as Prize)
          } else {
            reason =
              body?.claim?.pendingReason ?? body?.reason ?? 'Still working on it — try again shortly.'
          }
        }

        if (recovered.length > 0) {
          setWon((w) => [...w, ...recovered])
          setPhase('won')
          setPendingReason(reason)
          if (!reason) clearPendingCapsule(id, txHash)
        } else if (unitList === 'probe' && units.length === 0 && recovered.length === 0) {
          // A single-unit pasted hash whose play pended: the reason is already
          // set by openUnit; keep the pending face.
          setPhase('pending')
        } else {
          setPhase('pending')
          setPendingReason(reason ?? 'Still working on it — try again shortly.')
        }
      } finally {
        setResuming(null)
        loadClaims(addr)
        loadDiscovered(addr)
        setLocal(listPendingCapsules(id))
        load()
      }
    },
    [account, ensureConnected, id, load, loadClaims, loadDiscovered, openUnit],
  )

  if (loadError) {
    return (
      <div className="border border-line p-8 sm:p-16 text-center">
        <p className="text-sm font-mono text-muted">this machine is unavailable</p>
      </div>
    )
  }

  // No odds, no button. See the header comment — this is the compliance
  // structure, not a loading nicety.
  if (!data) {
    return (
      <div className="border border-line p-8 sm:p-16 text-center">
        <p className="text-sm font-mono text-muted">loading the lineup…</p>
      </div>
    )
  }

  const playable = data.machine.state === 'live'
  const busy = phase === 'paying' || phase === 'opening'
  // Everything still owed, from three records that each cover a hole in the
  // others, deduplicated by transaction:
  //   1. the server's claims — durable, cross-device, but only for plays the
  //      server has heard of;
  //   2. chain discovery — capsules minted through ANY frontend, read from
  //      TransferSingle logs, minus units with a claim row of their own;
  //   3. this browser's local ledger — the narrow window between a mint
  //      landing here and the server recording anything, minus whatever the
  //      other two already cover.
  const unresolved = claims.filter((c) => c.unresolved)
  const discoveredOwed = discovered
    .map((d) => ({
      ...d,
      owedUnits: d.owedUnits.filter(
        (u) => !claims.some((k) => k.txHash === d.txHash && k.unitIndex === u),
      ),
    }))
    .filter((d) => d.owedUnits.length > 0)
  const orphaned = local.filter(
    (c) =>
      !claims.some((k) => k.txHash === c.txHash) &&
      !discovered.some((d) => d.txHash === c.txHash),
  )

  return (
    <div className="max-w-3xl mx-auto">
      <header className="mb-6">
        <h1 className="text-lg font-mono tracking-wider text-ink">{data.machine.name}</h1>
        <p className="text-[11px] font-mono text-muted mt-1">
          by {shortAddress(data.machine.creator)} · every play returns an artwork
          {data.machine.splitRecipients.length > 0 && (
            <> · pays {data.machine.splitRecipients.length} recipient
              {data.machine.splitRecipients.length === 1 ? '' : 's'}</>
          )}
          {spark > 0 && <> · {spark} {spark === 1 ? 'play' : 'plays'} here</>}
        </p>
      </header>

      {/* The machine. The reveal replaces this face in place, so the capsule
          appears to open rather than the page appearing to navigate. */}
      <div className="border border-line bg-surface p-6 sm:p-10 text-center">
        {phase === 'won' && won.length > 0 ? (
          <div>
            <p className="text-xs font-mono uppercase tracking-widest accent-grad">
              {won.length === 1 ? 'you won' : `you won ${won.length}`}
            </p>
            <div className={`mt-5 grid gap-3 ${won.length === 1 ? 'grid-cols-1' : 'grid-cols-2 sm:grid-cols-3'}`}>
              {won.map((p, i) => (
                <Link
                  key={`${p.collection}:${p.tokenId}:${i}`}
                  href={`/artwork/${p.collection}/${p.tokenId}`}
                  className="group block"
                >
                  <div className={`relative overflow-hidden border border-line bg-raised ${won.length === 1 ? 'aspect-square max-w-[15rem] mx-auto' : 'aspect-square'}`}>
                    {p.image ? (
                      <MomentImage src={p.image} alt="" fill className="object-cover" sizes="240px" />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-subtle">
                        #{p.tokenId}
                      </div>
                    )}
                  </div>
                  <p className="mt-2 text-[11px] font-mono text-ink truncate group-hover:underline">
                    {artworkTitle(p.name, p.tokenId)}
                  </p>
                  <p className="text-[10px] font-mono text-muted truncate">by {shortAddress(p.artist)}</p>
                </Link>
              ))}
            </div>
            <p className="text-[11px] font-mono text-muted mt-4">
              {won.length === 1 ? 'it is' : 'they are'} already in your wallet
            </p>
            {pendingReason && (
              <p className="text-[11px] font-mono text-[#ffcf70] mt-2">{pendingReason}</p>
            )}
            <PlayControl
              playable={playable}
              busy={busy}
              pull={pull}
              setPull={setPull}
              onPlay={play}
              label="play again"
            />
          </div>
        ) : phase === 'pending' ? (
          <div>
            <p className="text-xs font-mono uppercase tracking-widest text-ink">your artwork is on its way</p>
            <p className="text-[11px] font-mono text-muted mt-2 max-w-sm mx-auto">{pendingReason}</p>
            {lastTx && <p className="text-[10px] font-mono text-subtle mt-3 break-all">{lastTx}</p>}
            {/* A pending result used to be a dead end with no control at all —
                the player's only escape was knowing to reload the page. */}
            <div className="mt-5 flex flex-wrap gap-2 justify-center">
              {lastTx && (
                <button
                  onClick={() => resume(lastTx, 'probe')}
                  disabled={!!resuming}
                  className="px-4 py-2 text-xs font-mono tracking-widest uppercase border border-line text-dim hover:text-ink disabled:opacity-40"
                >
                  {resuming ? 'checking…' : 'try again'}
                </button>
              )}
              <button
                onClick={() => { setPhase('idle'); setPendingReason(null) }}
                className="px-4 py-2 text-xs font-mono tracking-widest uppercase border border-line text-dim hover:text-ink"
              >
                back to the machine
              </button>
            </div>
          </div>
        ) : (
          <div>
            {data.machine.capsuleArt?.image && (
              <div className="relative w-28 h-28 sm:w-36 sm:h-36 mx-auto mb-5 overflow-hidden border border-line bg-raised">
                <MomentImage
                  src={data.machine.capsuleArt.image}
                  alt=""
                  fill
                  className="object-cover"
                  sizes="144px"
                />
              </div>
            )}
            <p className="text-xs font-mono uppercase tracking-widest text-muted">
              {phase === 'opening'
                ? progress && progress.total > 1
                  ? `opening ${progress.done + 1} of ${progress.total}…`
                  : 'opening…'
                : phase === 'paying'
                  ? 'confirm in wallet…'
                  : 'insert coin'}
            </p>
            <PlayControl
              playable={playable}
              busy={busy}
              pull={pull}
              setPull={setPull}
              onPlay={play}
              label={playable ? 'play' : 'season closed'}
            />
          </div>
        )}
      </div>

      {/* Anything paid for and not yet delivered, from either record. */}
      {(unresolved.length > 0 || orphaned.length > 0 || discoveredOwed.length > 0) && (
        <section className="mt-4 border border-[#4a3a1a] bg-[#1a1408] p-4">
          <h2 className="text-[11px] font-mono uppercase tracking-widest text-[#ffcf70] mb-2">
            still opening
          </h2>
          <p className="text-[11px] font-mono text-muted mb-3">
            These capsules are paid for and owed to you. Nothing expires.
          </p>
          <div className="flex flex-col gap-2">
            {unresolved.map((c) => (
              <div key={`${c.txHash}:${c.unitIndex}`} className="flex items-center gap-3">
                <span className="flex-1 min-w-0 text-[10px] font-mono text-subtle truncate">
                  {c.txHash.slice(0, 10)}… · unit {c.unitIndex} · {c.state}
                </span>
                <button
                  onClick={() => resume(c.txHash, [c.unitIndex])}
                  disabled={resuming === `${c.txHash}:${c.unitIndex}`}
                  className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider border border-line text-dim hover:text-ink disabled:opacity-40 shrink-0"
                >
                  {resuming === `${c.txHash}:${c.unitIndex}` ? 'opening…' : 'open'}
                </button>
              </div>
            ))}
            {discoveredOwed.map((d) => (
              <div key={`d:${d.txHash}`} className="flex items-center gap-3">
                <span className="flex-1 min-w-0 text-[10px] font-mono text-subtle truncate">
                  {d.txHash.slice(0, 10)}… · {d.owedUnits.length} of {d.units} unopened
                </span>
                <button
                  onClick={() => resume(d.txHash, d.owedUnits)}
                  disabled={resuming === `${d.txHash}:${d.owedUnits[0]}`}
                  className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider border border-line text-dim hover:text-ink disabled:opacity-40 shrink-0"
                >
                  {resuming === `${d.txHash}:${d.owedUnits[0]}` ? 'opening…' : 'open'}
                </button>
              </div>
            ))}
            {orphaned.map((c) => (
              <div key={c.txHash} className="flex items-center gap-3">
                <span className="flex-1 min-w-0 text-[10px] font-mono text-subtle truncate">
                  {c.txHash.slice(0, 10)}… · {c.units} capsule{c.units === 1 ? '' : 's'} · not opened
                </span>
                <button
                  onClick={() => resume(c.txHash, 'probe')}
                  disabled={resuming === `${c.txHash}:probe`}
                  className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider border border-line text-dim hover:text-ink disabled:opacity-40 shrink-0"
                >
                  {resuming === `${c.txHash}:probe` ? 'opening…' : 'open'}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Coverage — rendered from the same state the draw uses, so it cannot
          flatter the machine. */}
      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-[11px] font-mono text-muted">
        <span>
          artworks left:{' '}
          <span className="text-dim">
            {data.coverage.prizesRemaining === null ? 'always available' : data.coverage.prizesRemaining}
          </span>
        </span>
        {data.coverage.capsulesOutstanding !== null && (
          <span>
            capsules left: <span className="text-dim">{data.coverage.capsulesOutstanding}</span>
          </span>
        )}
        {!data.coverage.covered && <span className="text-[#ff7c80]">coverage below capsules outstanding</span>}
      </div>

      {/* The odds. Derived server-side from the same snapshot a play draws from —
          there is no field anywhere a creator can type a percentage into. */}
      <section className="mt-8">
        <h2 className="text-[11px] font-mono uppercase tracking-widest text-muted mb-3">
          what&apos;s inside · published odds
        </h2>
        <div className="border border-line divide-y divide-line">
          {data.odds.map((o) => {
            const ratio = formatOddsRatio(o.probability)
            return (
              <Link
                key={o.key}
                href={`/artwork/${o.collection}/${o.tokenId}`}
                className="flex items-center gap-3 px-3 py-2.5 hover:bg-raised transition-colors"
              >
                <div className="relative w-10 h-10 shrink-0 overflow-hidden border border-line bg-raised">
                  {o.image ? (
                    <MomentImage src={o.image} alt="" fill className="object-cover" sizes="40px" />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-[8px] font-mono text-subtle">
                      #{o.tokenId}
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-mono text-dim truncate">{artworkTitle(o.name, o.tokenId)}</p>
                  <p className="text-[10px] font-mono text-subtle truncate">
                    by {shortAddress(o.artist)} · {formatRemaining(o.remaining)}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p
                    className={`text-xs font-mono tabular-nums ${
                      o.probability === 0 ? 'text-subtle' : 'text-ink'
                    }`}
                  >
                    {formatProbability(o.probability)}
                  </p>
                  {ratio && <p className="text-[10px] font-mono text-subtle tabular-nums">{ratio}</p>}
                </div>
              </Link>
            )
          })}
        </div>
      </section>

      {/* Fairness. The commitment is published BEFORE any of today's plays
          exist, and tomorrow's is already fixed too — which is the part that
          makes "committed in advance" checkable rather than merely asserted. */}
      {data.fairness && (
        <section className="mt-6">
          <h2 className="text-[11px] font-mono uppercase tracking-widest text-muted mb-2">provably fair</h2>
          <dl className="text-[11px] font-mono text-subtle leading-relaxed">
            <div className="flex gap-2">
              <dt className="text-muted shrink-0">{data.fairness.epoch}</dt>
              <dd className="break-all">{data.fairness.commitment}</dd>
            </div>
            <div className="flex gap-2 mt-1">
              <dt className="text-muted shrink-0">{data.fairness.next.epoch}</dt>
              <dd className="break-all">{data.fairness.next.commitment}</dd>
            </div>
          </dl>
          <p className="text-[11px] font-mono text-muted mt-2">
            Tomorrow&apos;s seed is already locked — record it now and hold us to it. After a day closes,
            any play from it can be recomputed from the revealed seed.
          </p>
          <Link
            href={`/experience/${id}/verify${lastTx ? `?txHash=${lastTx}` : ''}`}
            className="inline-block mt-2 text-[11px] font-mono text-dim hover:text-ink underline"
          >
            verify a play →
          </Link>
        </section>
      )}

      {/* The floor under every recovery path. Discovery needs the RPC to answer
          and a connected wallet; this needs neither fact about us to be true —
          any capsule transaction hash, from any frontend, any device, opens
          through the same verified play route. */}
      <section className="mt-6">
        <h2 className="text-[11px] font-mono uppercase tracking-widest text-muted mb-2">
          minted a capsule elsewhere?
        </h2>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={redeemHash}
            onChange={(e) => setRedeemHash(e.target.value.trim())}
            placeholder="paste its transaction hash (0x…)"
            spellCheck={false}
            aria-label="Capsule transaction hash to redeem"
            className="flex-1 min-w-0 bg-transparent border border-line px-3 py-2 text-[11px] font-mono text-ink placeholder:text-subtle focus:outline-none focus:border-dim"
          />
          <button
            onClick={() => {
              if (/^0x[0-9a-fA-F]{64}$/.test(redeemHash)) resume(redeemHash, 'probe')
            }}
            disabled={!!resuming || !/^0x[0-9a-fA-F]{64}$/.test(redeemHash)}
            className="px-4 py-2 text-[10px] font-mono uppercase tracking-wider border border-line text-dim hover:text-ink disabled:opacity-40 shrink-0"
          >
            {resuming === `${redeemHash}:probe` ? 'opening…' : 'redeem'}
          </button>
        </div>
        <p className="text-[10px] font-mono text-subtle mt-1.5">
          Capsules minted on zora.co or anywhere else work here — the play is proved against the
          transaction itself.
        </p>
      </section>

      {data.recentPlays.length > 0 && (
        <section className="mt-6">
          <h2 className="text-[11px] font-mono uppercase tracking-widest text-muted mb-2">recent plays</h2>
          <div className="flex flex-wrap gap-2">
            {data.recentPlays.map((p) => (
              <Link
                key={p.txHash}
                href={`/profile/${p.player}`}
                className="text-[10px] font-mono text-subtle hover:text-dim border border-line px-2 py-1"
              >
                {shortAddress(p.player)}
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

/** The play control: a pull-size selector and the button, kept together so the
 *  count a player is about to pay for is never separated from the action. */
function PlayControl({
  playable,
  busy,
  pull,
  setPull,
  onPlay,
  label,
}: {
  playable: boolean
  busy: boolean
  pull: number
  setPull: (n: number) => void
  onPlay: () => void
  label: string
}) {
  return (
    <div className="mt-5">
      {playable && (
        <div className="flex items-center justify-center gap-1 mb-3">
          {PULL_SIZES.map((n) => (
            <button
              key={n}
              onClick={() => setPull(n)}
              disabled={busy}
              className={`px-3 py-1 text-[10px] font-mono tracking-wider uppercase border transition-colors disabled:opacity-40 ${
                pull === n ? 'border-ink text-ink' : 'border-line text-subtle hover:text-dim'
              }`}
            >
              ×{n}
            </button>
          ))}
        </div>
      )}
      <button
        onClick={onPlay}
        disabled={busy || !playable}
        className="px-6 py-3 text-xs font-mono tracking-widest uppercase btn-accent disabled:opacity-40"
      >
        {busy ? 'working…' : playable && pull > 1 ? `${label} ×${pull}` : label}
      </button>
    </div>
  )
}
