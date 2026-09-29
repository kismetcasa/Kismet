'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAccount } from 'wagmi'
import { toast } from 'sonner'
import { useUploadSession } from '@/hooks/useUploadSession'
import { useEnsureConnected } from '@/hooks/useEnsureConnected'
import { usePassGate } from '@/hooks/usePassGate'
import { isAddress } from '@/lib/address'
import { deriveOdds, MAX_POOL_ENTRIES } from '@/lib/experience/draw'
import { formatOddsRatio, formatProbability, parseArtworkRef } from '@/lib/experience/format'
import type { PoolEntry, Rarity, SolvencyProblemCode } from '@/lib/experience/types'
import { shortAddress } from '@/lib/inprocess'

/**
 * The Capsule Studio: build a capsule machine from your own work, see exactly
 * what players will see, publish.
 *
 * ── The one idea this form is organised around ──
 *
 * A CREATOR SETS WEIGHTS AND SUPPLIES, NEVER ODDS. There is no percentage field
 * anywhere on this page, and there cannot be one: the preview below runs the
 * SAME `deriveOdds` the machine page and the draw itself run, over the rows as
 * typed. So a creator watches the real distribution move as they set weights,
 * and the number they see is the number a player will see because it is
 * computed by the same function from the same data.
 *
 * ── Why validation is a server dry run and not a client approximation ──
 *
 * Solvency depends on live on-chain headroom and on what OTHER machines have
 * already pledged against the same editions. A client-side guess at that would
 * eventually disagree with the publish gate, and a preview that can disagree
 * with the gate is worse than no preview — it teaches creators to distrust it.
 * So every check here is `dryRun: true` against the real create route, which
 * runs the identical code path and writes nothing.
 */

interface Row {
  collection: string
  tokenId: string
  weight: string
  supply: string
}

interface Problem {
  code: SolvencyProblemCode
  detail: string
}

const BLANK: Row = { collection: '', tokenId: '', weight: '10', supply: '1' }

/** Rows complete enough to price. A half-typed row must not silently reshape
 *  the preview distribution, so it is excluded until it is whole. Every piece
 *  is the creator's own, and by supply its copies are its weight — the same
 *  two rules the publish route applies. */
function toEntries(rows: Row[], creator: string, rarity: Rarity): PoolEntry[] {
  const out: PoolEntry[] = []
  for (const r of rows) {
    if (!isAddress(r.collection) || !/^\d+$/.test(r.tokenId)) continue
    const supply = Number(r.supply)
    const weight = rarity === 'supply' ? supply : Number(r.weight)
    if (!Number.isFinite(weight) || !Number.isFinite(supply)) continue
    out.push({
      collection: r.collection.toLowerCase(),
      tokenId: r.tokenId,
      artist: creator,
      weight,
      supply,
    })
  }
  return out
}

export function CapsuleStudio() {
  const router = useRouter()
  const { address } = useAccount()
  const { ensureSession } = useUploadSession()
  const ensureConnected = useEnsureConnected()
  const { gatedOut, passCollectionHref, passCollectionName } = usePassGate()

  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [capsuleCollection, setCapsuleCollection] = useState('')
  const [capsuleTokenId, setCapsuleTokenId] = useState('')
  const [rows, setRows] = useState<Row[]>([{ ...BLANK }])
  const [rarity, setRarity] = useState<Rarity>('manual')
  const [problems, setProblems] = useState<Problem[] | null>(null)
  const [capsuleInfo, setCapsuleInfo] = useState<{ maxSupply: number | null; minted: number } | null>(null)
  const [payees, setPayees] = useState<{ recipients: string[]; source: 'split' | 'creator' } | null>(null)
  const [checking, setChecking] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [authRequired, setAuthRequired] = useState(false)
  /** A machine that went to review. Held here rather than navigated to: the
   *  machine page is public and 404s anything not yet approved, so the old
   *  redirect landed every non-admin creator on "not found" the moment their
   *  "Submitted for review" toast faded. */
  const [submitted, setSubmitted] = useState<{ id: string; name: string } | null>(null)

  const creator = address?.toLowerCase() ?? ''
  const entries = useMemo(() => toEntries(rows, creator, rarity), [rows, creator, rarity])
  /** Whether each complete row's piece allows capsule machines, so an
   *  unallowed piece is flagged while the creator is still building, not only
   *  when they run a check. */
  const [pieces, setPieces] = useState<Record<string, { allowed: boolean | null } | 'loading'>>({})
  useEffect(() => {
    for (const r of rows) {
      if (!isAddress(r.collection) || !/^\d+$/.test(r.tokenId)) continue
      const key = pieceKey(r)
      if (pieces[key] !== undefined) continue
      setPieces((p) => ({ ...p, [key]: 'loading' }))
      fetch(`/api/experience/piece?collection=${r.collection}&tokenId=${r.tokenId}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((d: { allowed: boolean | null } | null) => {
          setPieces((p) => ({ ...p, [key]: { allowed: d?.allowed ?? null } }))
        })
        .catch(() => setPieces((p) => ({ ...p, [key]: { allowed: null } })))
    }
  }, [rows, pieces])
  // The real published table, computed by the production function over a
  // snapshot where every entry is fully stocked — which is what a machine looks
  // like on its opening day.
  const preview = useMemo(
    () => deriveOdds(entries.map((e) => ({ ...e, remaining: e.supply === 0 ? null : e.supply }))),
    [entries],
  )
  const hasFloor = entries.some((e) => e.supply === 0)
  const totalCopies = entries.reduce((sum, e) => sum + (e.supply > 0 ? e.supply : 0), 0)

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, j) => (i === j ? { ...r, ...patch } : r)))

  const payload = useCallback(
    (dryRun: boolean) => ({
      id: id.trim().toLowerCase(),
      name: name.trim(),
      rarity,
      capsule: { collection: capsuleCollection.trim(), tokenId: capsuleTokenId.trim() },
      entries,
      // No splitRecipients. The server resolves who the capsule actually pays
      // from the split Kismet recorded at mint time — sending a list from here
      // is what made the 'artist-not-in-split' check circular, since the same
      // person supplied both the pool and the list it was checked against.
      dryRun,
    }),
    [capsuleCollection, capsuleTokenId, entries, id, name, rarity],
  )

  const submit = useCallback(
    async (dryRun: boolean) => {
      if (dryRun) setChecking(true)
      else setPublishing(true)
      try {
        // Both buttons need a session, not only publish: every verdict the
        // check returns — capsule control, who the capsule pays, whose floor
        // piece it is — is a question about THIS creator, so the route refuses
        // an anonymous dry run. `revalidate` re-probes after a server 401 —
        // the module cache says the cookie is fine and the server just said
        // otherwise — instead of trusting the cache into a permanent no-op.
        await ensureSession({ revalidate: authRequired })
        setAuthRequired(false)
        const r = await fetch('/api/experience/machines', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload(dryRun)),
        })
        const body = await r.json().catch(() => null)

        if (r.status === 401) { setAuthRequired(true); return }
        if (Array.isArray(body?.problems)) {
          setProblems(body.problems as Problem[])
          if (body.capsule) setCapsuleInfo(body.capsule)
          if (body.payees) setPayees(body.payees)
          if (body.problems.length === 0 && dryRun) toast.success('Ready to publish')
          return
        }
        if (!r.ok) {
          toast.error(body?.error ?? 'Could not validate this machine')
          return
        }
        if (!dryRun && body?.machine) {
          if (body.machine.state === 'live') {
            toast.success('Machine is live')
            router.push(`/play/${body.machine.id}`)
            return
          }
          toast.success('Submitted for review')
          setSubmitted({ id: body.machine.id, name: body.machine.name })
        }
      } catch {
        toast.error(dryRun ? 'Could not validate' : 'Could not publish')
      } finally {
        setChecking(false)
        setPublishing(false)
      }
    },
    [authRequired, ensureSession, payload, router],
  )

  if (submitted) return <StudioSubmitted title="capsule studio" machine={submitted} address={address} />

  return (
    <div className="max-w-3xl mx-auto">
      <header className="mb-6">
        <h1 className="text-lg font-mono tracking-wider text-ink">capsule studio</h1>
        <p className="text-[11px] font-mono text-muted mt-1 max-w-xl leading-relaxed">
          A machine of your own work: players pay your capsule price once and get one of your pieces. You
          set the rarity; the odds are derived from it and published automatically — there is no percentage
          to type, and no way for the table players see to differ from the one the draw uses. To curate other
          artists&apos; work, open a{' '}
          <Link href="/play/create-reveal" className="text-dim hover:text-ink underline">
            reveal machine
          </Link>{' '}
          instead.
        </p>
      </header>

      {gatedOut && (
        <div className="border border-line p-4 mb-6">
          <p className="text-xs font-mono text-ink">a Kismet Pass is required to open a machine</p>
          <p className="text-[11px] font-mono text-muted mt-1.5">
            The Pass is earned on-platform and can&apos;t be bought or transferred into — which is what keeps
            machines from becoming a spam surface.
          </p>
          <Link href={passCollectionHref} className="inline-block mt-2 text-[11px] font-mono text-dim hover:text-ink underline">
            collect {passCollectionName ?? 'a Pass'} →
          </Link>
        </div>
      )}

      <Section title="before you start">
        <ol className="flex flex-col gap-1.5 text-[11px] font-mono text-muted leading-relaxed list-decimal list-inside max-w-xl">
          <li>Mint the capsule on Kismet: a priced edition that pays you.</li>
          <li>Allow capsule machines on each piece you&apos;ll put in, from that piece&apos;s page.</li>
          <li>
            Add an unlimited piece as a floor, or cap the capsule at the number of copies you put in, so every
            capsule sold can always be honoured.
          </li>
        </ol>
      </Section>

      <Section title="the machine">
        <Field label="id" hint="lowercase letters, numbers and dashes — this becomes the URL">
          <input
            value={id}
            onChange={(e) => setId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            placeholder="spring-season"
            className={inputClass}
          />
        </Field>
        <Field label="name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Spring Season" className={inputClass} />
        </Field>
      </Section>

      <Section
        title="the capsule"
        note="The token players mint to play. Its price is the coin slot, its sale window is the season, and its on-chain max supply is the ceiling on how many artworks you can ever owe."
      >
        <Field label="collection">
          <input
            value={capsuleCollection}
            onChange={(e) => setCapsuleCollection(e.target.value.trim())}
            placeholder="0x…"
            spellCheck={false}
            className={inputClass}
          />
        </Field>
        <Field label="token id">
          <input
            value={capsuleTokenId}
            onChange={(e) => setCapsuleTokenId(e.target.value.replace(/\D/g, ''))}
            placeholder="1"
            inputMode="numeric"
            className={inputClass}
          />
        </Field>
        {capsuleInfo && (
          <p className="text-[11px] font-mono text-muted">
            on-chain: {capsuleInfo.maxSupply === null ? 'open edition' : `${capsuleInfo.maxSupply} max`} ·{' '}
            {capsuleInfo.minted} minted
          </p>
        )}
      </Section>

      <Section
        title="rarity"
        note={
          rarity === 'supply'
            ? 'Odds follow each piece’s total copies: a piece with 20 copies comes out 20 times as often as a one-of-one, and a one-of-one stays that rare all season.'
            : 'You give each piece a weight. A piece with twice the weight comes out twice as often.'
        }
      >
        <div className="flex gap-1" role="radiogroup" aria-label="Rarity">
          {(['manual', 'supply'] as const).map((r) => (
            <button
              key={r}
              role="radio"
              aria-checked={rarity === r}
              onClick={() => setRarity(r)}
              className={`px-3 py-1.5 text-[10px] font-mono tracking-wider uppercase border transition-colors ${
                rarity === r ? 'border-ink text-ink' : 'border-line text-subtle hover:text-dim'
              }`}
            >
              {r === 'manual' ? 'set per piece' : 'by supply'}
            </button>
          ))}
        </div>
      </Section>

      <Section
        title="the lineup"
        note={
          rarity === 'supply'
            ? 'Your own pieces. Give each one a number of copies.'
            : 'Your own pieces. Qty 0 means unlimited.'
        }
      >
        <div className="flex flex-col gap-2">
          {rows.map((r, i) => (
            <div key={i} className="border border-line p-3 flex flex-col gap-2">
              <div className="flex gap-2">
                <input
                  value={r.collection}
                  onChange={(e) => {
                    const ref = parseArtworkRef(e.target.value)
                    setRow(i, ref ? { collection: ref.collection, tokenId: ref.tokenId } : { collection: e.target.value.trim() })
                  }}
                  placeholder="artwork link, or collection 0x…"
                  spellCheck={false}
                  aria-label={`Artwork ${i + 1}: link or collection address`}
                  className={`${inputClass} flex-1`}
                />
                <input value={r.tokenId} onChange={(e) => setRow(i, { tokenId: e.target.value.replace(/\D/g, '') })} placeholder="token" inputMode="numeric" className={`${inputClass} w-20`} />
              </div>
              <div className="flex gap-2 justify-end">
                {rarity === 'manual' && (
                  <label className="flex items-center gap-1">
                    <span className="text-[10px] font-mono text-subtle uppercase">wt</span>
                    <input value={r.weight} onChange={(e) => setRow(i, { weight: e.target.value.replace(/\D/g, '') })} inputMode="numeric" aria-label={`Artwork ${i + 1} weight`} className={`${inputClass} w-16`} />
                  </label>
                )}
                <label className="flex items-center gap-1">
                  <span className="text-[10px] font-mono text-subtle uppercase">qty</span>
                  <input value={r.supply} onChange={(e) => setRow(i, { supply: e.target.value.replace(/\D/g, '') })} inputMode="numeric" aria-label={`Artwork ${i + 1} copies`} className={`${inputClass} w-16`} />
                </label>
                <button
                  onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                  aria-label={`Remove artwork ${i + 1}`}
                  className="px-2 text-[10px] font-mono text-subtle hover:text-[#ff7c80]"
                >
                  remove
                </button>
              </div>
              <PieceStatus row={r} standing={pieces[pieceKey(r)]} />
            </div>
          ))}
        </div>
        <button
          onClick={() => setRows((rs) => (rs.length < MAX_POOL_ENTRIES ? [...rs, { ...BLANK }] : rs))}
          className="mt-2 px-4 py-2 text-[10px] font-mono uppercase tracking-wider border border-line text-dim hover:text-ink"
        >
          add artwork
        </button>
      </Section>

      {/* The published table, live. Same function, same data as the real one. */}
      {preview.length > 0 && (
        <Section title="what players will see">
          <div className="border border-line divide-y divide-line">
            {preview.map((o) => {
              const ratio = formatOddsRatio(o.probability)
              return (
                <div key={`${o.collection}:${o.tokenId}`} className="flex items-center gap-3 px-3 py-2">
                  <span className="flex-1 min-w-0 text-[11px] font-mono text-dim truncate">
                    #{o.tokenId} <span className="text-subtle">{shortAddress(o.collection)}</span>
                  </span>
                  <span className="text-[10px] font-mono text-subtle shrink-0">
                    {o.remaining === null ? 'unlimited' : `${o.remaining}`}
                  </span>
                  <span className="text-xs font-mono tabular-nums text-ink shrink-0 w-20 text-right">
                    {formatProbability(o.probability)}
                  </span>
                  <span className="text-[10px] font-mono tabular-nums text-subtle shrink-0 w-20 text-right">
                    {ratio ?? ''}
                  </span>
                </div>
              )
            })}
          </div>
          {/* What the capsule REALLY pays, read back from the server — not a
              restatement of what this form just declared. */}
          {payees ? (
            <p className="text-[11px] font-mono text-muted mt-2">
              {payees.source === 'creator' ? (
                <>This capsule has no split, so every play pays you.</>
              ) : (
                <>
                  This capsule pays {payees.recipients.length} recipient
                  {payees.recipients.length === 1 ? '' : 's'}:{' '}
                  {payees.recipients.map((a) => shortAddress(a)).join(', ')}. You must be one of them.
                </>
              )}
            </p>
          ) : (
            <p className="text-[11px] font-mono text-subtle mt-2">
              Run <span className="text-dim">check</span> to see who this capsule actually pays.
            </p>
          )}
          {rarity === 'supply' ? (
            <p className="text-[11px] font-mono text-muted mt-1">
              {totalCopies} {totalCopies === 1 ? 'copy' : 'copies'} in the machine — cap the capsule at{' '}
              {totalCopies} or fewer.
            </p>
          ) : (
            !hasFloor && (
              <p className="text-[11px] font-mono text-[#ffcf70] mt-1">
                No floor piece yet. An unlimited piece guarantees every capsule can be honoured — without one,
                you can only sell as many capsules as you have capped copies.
              </p>
            )
          )}
        </Section>
      )}

      {problems && (
        <Section title={problems.length === 0 ? 'ready' : 'fix before publishing'}>
          {problems.length === 0 ? (
            <p className="text-[11px] font-mono text-[#7ee787]">
              Every check passed against live on-chain state.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {problems.map((p, i) => (
                <li key={i} className="text-[11px] font-mono text-[#ff7c80]">
                  <span className="text-subtle uppercase tracking-wider">{p.code}</span> — <DetailWithLinks text={p.detail} />
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {authRequired && (
        <p className="text-[11px] font-mono text-[#ffcf70] mb-4">
          Sign in with your wallet and try again.
        </p>
      )}

      {/* Nothing here can be answered for an anonymous visitor — every check is
          about the connected creator — so a disconnected wallet gets the one
          action that makes the others possible, rather than a check whose
          only outcome is a sign-in error. */}
      <div className="flex flex-wrap gap-2 mt-8 mb-16">
        {!address ? (
          <button
            onClick={() => void ensureConnected()}
            className="px-5 py-2.5 text-xs font-mono tracking-widest uppercase btn-accent"
          >
            connect wallet
          </button>
        ) : (
          <>
            <button
              onClick={() => submit(true)}
              disabled={checking || publishing || entries.length === 0}
              className="px-5 py-2.5 text-xs font-mono tracking-widest uppercase border border-line text-dim hover:text-ink disabled:opacity-40"
            >
              {checking ? 'checking…' : 'check'}
            </button>
            <button
              onClick={() => submit(false)}
              disabled={checking || publishing || entries.length === 0 || gatedOut}
              className="px-5 py-2.5 text-xs font-mono tracking-widest uppercase btn-accent disabled:opacity-40"
            >
              {publishing ? 'publishing…' : 'publish'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** Where a machine sent for review lands: it is not public yet, so the page
 *  says where it will be and where the creator can watch it meanwhile. */
export function StudioSubmitted({
  title,
  machine,
  address,
}: {
  title: string
  machine: { id: string; name: string }
  address: string | undefined
}) {
  return (
    <div className="max-w-3xl mx-auto">
      <header className="mb-6">
        <h1 className="text-lg font-mono tracking-wider text-ink">{title}</h1>
      </header>
      <section className="border border-line p-6">
        <p className="text-xs font-mono uppercase tracking-widest text-ink">submitted for review</p>
        <p className="text-[11px] font-mono text-muted mt-2 max-w-lg leading-relaxed">
          <span className="text-dim">{machine.name}</span> is queued for a curator. It isn&apos;t public
          yet; once approved it will be live at{' '}
          <span className="text-dim">/play/{machine.id}</span>, and you&apos;ll be notified either
          way.
        </p>
        <div className="flex flex-wrap gap-4 mt-4">
          {address && (
            <Link href={`/profile/${address}`} className="text-[11px] font-mono text-dim hover:text-ink underline">
              see it on your profile →
            </Link>
          )}
          <Link href="/play" className="text-[11px] font-mono text-dim hover:text-ink underline">
            back to play →
          </Link>
        </div>
      </section>
    </div>
  )
}

export const inputClass =
  'bg-transparent border border-line px-3 py-2 text-xs font-mono text-ink placeholder:text-subtle focus:outline-none focus:border-dim min-w-0'

export function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-[11px] font-mono uppercase tracking-widest text-muted mb-2">{title}</h2>
      {note && <p className="text-[11px] font-mono text-subtle mb-3 max-w-xl leading-relaxed">{note}</p>}
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-mono uppercase tracking-wider text-subtle">{label}</span>
      {children}
      {hint && <span className="text-[10px] font-mono text-subtle">{hint}</span>}
    </label>
  )
}

export const pieceKey = (r: { collection: string; tokenId: string }) =>
  `${r.collection.toLowerCase()}:${/^\d+$/.test(r.tokenId) ? BigInt(r.tokenId).toString() : r.tokenId}`

/** One lineup row's standing with capsule machines, while the creator builds. */
function PieceStatus({
  row,
  standing,
}: {
  row: Row
  standing: { allowed: boolean | null } | 'loading' | undefined
}) {
  if (!standing || standing === 'loading' || standing.allowed === null) return null
  const href = `/artwork/${row.collection.toLowerCase()}/${row.tokenId}`
  return standing.allowed ? (
    <p className="text-[10px] font-mono text-subtle">allowed for capsule machines</p>
  ) : (
    <p className="text-[10px] font-mono text-[#ffcf70]">
      Not allowed for capsule machines yet — allow it from{' '}
      <Link href={href} className="underline hover:text-ink">
        the piece&apos;s page
      </Link>
      .
    </p>
  )
}

/** A problem's detail with any artwork path in it made a link. */
export function DetailWithLinks({ text }: { text: string }) {
  const parts = text.split(/(\/artwork\/0x[0-9a-fA-F]{40}\/\d+)/)
  return (
    <>
      {parts.map((part, i) =>
        /^\/artwork\//.test(part) ? (
          <Link key={i} href={part} className="underline hover:text-ink">
            {part}
          </Link>
        ) : (
          part
        ),
      )}
    </>
  )
}
