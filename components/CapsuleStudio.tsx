'use client'

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAccount } from 'wagmi'
import { toast } from 'sonner'
import { useUploadSession } from '@/hooks/useUploadSession'
import { usePassGate } from '@/hooks/usePassGate'
import { isAddress } from '@/lib/address'
import { deriveOdds, poolArtists, MAX_POOL_ENTRIES } from '@/lib/experience/draw'
import { formatOddsRatio, formatProbability } from '@/lib/experience/format'
import type { PoolEntry, SolvencyProblemCode } from '@/lib/experience/types'
import { shortAddress } from '@/lib/inprocess'

/**
 * The Capsule Studio: build a machine, see exactly what players will see, publish.
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
  artist: string
  weight: string
  supply: string
}

interface Problem {
  code: SolvencyProblemCode
  detail: string
}

const BLANK: Row = { collection: '', tokenId: '', artist: '', weight: '10', supply: '1' }

/** Rows complete enough to price. A half-typed row must not silently reshape
 *  the preview distribution, so it is excluded until it is whole. */
function toEntries(rows: Row[]): PoolEntry[] {
  const out: PoolEntry[] = []
  for (const r of rows) {
    if (!isAddress(r.collection) || !/^\d+$/.test(r.tokenId) || !isAddress(r.artist)) continue
    const weight = Number(r.weight)
    const supply = Number(r.supply)
    if (!Number.isFinite(weight) || !Number.isFinite(supply)) continue
    out.push({
      collection: r.collection.toLowerCase(),
      tokenId: r.tokenId,
      artist: r.artist.toLowerCase(),
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
  const { gatedOut, passCollectionHref, passCollectionName } = usePassGate()

  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [capsuleCollection, setCapsuleCollection] = useState('')
  const [capsuleTokenId, setCapsuleTokenId] = useState('')
  const [rows, setRows] = useState<Row[]>([{ ...BLANK }])
  const [problems, setProblems] = useState<Problem[] | null>(null)
  const [capsuleInfo, setCapsuleInfo] = useState<{ maxSupply: number | null; minted: number } | null>(null)
  const [checking, setChecking] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [authRequired, setAuthRequired] = useState(false)

  const entries = useMemo(() => toEntries(rows), [rows])
  // The real published table, computed by the production function over a
  // snapshot where every entry is fully stocked — which is what a machine looks
  // like on its opening day.
  const preview = useMemo(
    () => deriveOdds(entries.map((e) => ({ ...e, remaining: e.supply === 0 ? null : e.supply }))),
    [entries],
  )
  const artists = useMemo(() => poolArtists(entries), [entries])
  const creator = address?.toLowerCase() ?? ''
  const hasFloor = entries.some((e) => e.supply === 0 && e.artist.toLowerCase() === creator)

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, j) => (i === j ? { ...r, ...patch } : r)))

  const payload = useCallback(
    (dryRun: boolean) => ({
      id: id.trim().toLowerCase(),
      name: name.trim(),
      capsule: { collection: capsuleCollection.trim(), tokenId: capsuleTokenId.trim() },
      entries,
      // Every pool artist must be able to be paid, and the creator takes the
      // remainder. Derived rather than typed: an artist missing from the split
      // is a machine giving away their work for free, and that must not be a
      // thing a creator can do by forgetting a field.
      splitRecipients: [...new Set([...artists, creator].filter(Boolean))],
      dryRun,
    }),
    [artists, capsuleCollection, capsuleTokenId, creator, entries, id, name],
  )

  const submit = useCallback(
    async (dryRun: boolean) => {
      if (dryRun) setChecking(true)
      else setPublishing(true)
      setAuthRequired(false)
      try {
        if (!dryRun) await ensureSession({ revalidate: false })
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
          if (body.problems.length === 0 && dryRun) toast.success('Ready to publish')
          return
        }
        if (!r.ok) {
          toast.error(body?.error ?? 'Could not validate this machine')
          return
        }
        if (!dryRun && body?.machine) {
          toast.success(
            body.machine.state === 'live' ? 'Machine is live' : 'Submitted for review',
          )
          router.push(`/experience/${body.machine.id}`)
        }
      } catch {
        toast.error(dryRun ? 'Could not validate' : 'Could not publish')
      } finally {
        setChecking(false)
        setPublishing(false)
      }
    },
    [ensureSession, payload, router],
  )

  return (
    <div className="max-w-3xl mx-auto">
      <header className="mb-6">
        <h1 className="text-lg font-mono tracking-wider text-ink">capsule studio</h1>
        <p className="text-[11px] font-mono text-muted mt-1 max-w-xl leading-relaxed">
          Build a machine. You set weights and supplies; the odds are derived from them and published
          automatically — there is no percentage to type, and no way for the table players see to differ from
          the one the draw uses.
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
        title="the lineup"
        note="Each artist must have granted this platform mint rights on the piece, and can revoke at any time. Supply 0 means unlimited."
      >
        <div className="flex flex-col gap-2">
          {rows.map((r, i) => (
            <div key={i} className="border border-line p-3 flex flex-col gap-2">
              <div className="flex gap-2">
                <input value={r.collection} onChange={(e) => setRow(i, { collection: e.target.value.trim() })} placeholder="collection 0x…" spellCheck={false} className={`${inputClass} flex-1`} />
                <input value={r.tokenId} onChange={(e) => setRow(i, { tokenId: e.target.value.replace(/\D/g, '') })} placeholder="token" inputMode="numeric" className={`${inputClass} w-20`} />
              </div>
              <div className="flex gap-2">
                <input value={r.artist} onChange={(e) => setRow(i, { artist: e.target.value.trim() })} placeholder="artist 0x…" spellCheck={false} className={`${inputClass} flex-1`} />
                <label className="flex items-center gap-1">
                  <span className="text-[10px] font-mono text-subtle uppercase">wt</span>
                  <input value={r.weight} onChange={(e) => setRow(i, { weight: e.target.value.replace(/\D/g, '') })} inputMode="numeric" className={`${inputClass} w-16`} />
                </label>
                <label className="flex items-center gap-1">
                  <span className="text-[10px] font-mono text-subtle uppercase">qty</span>
                  <input value={r.supply} onChange={(e) => setRow(i, { supply: e.target.value.replace(/\D/g, '') })} inputMode="numeric" className={`${inputClass} w-16`} />
                </label>
                <button
                  onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                  aria-label={`Remove artwork ${i + 1}`}
                  className="px-2 text-[10px] font-mono text-subtle hover:text-[#ff7c80]"
                >
                  remove
                </button>
              </div>
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
                    #{o.tokenId} <span className="text-subtle">by {shortAddress(o.artist)}</span>
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
          <p className="text-[11px] font-mono text-muted mt-2">
            splits pay {artists.length} artist{artists.length === 1 ? '' : 's'} plus you, on every play.
          </p>
          {!hasFloor && (
            <p className="text-[11px] font-mono text-[#ffcf70] mt-1">
              No floor piece yet. An unlimited artwork of your own guarantees every capsule can be honoured
              even if every other artist withdraws — without one, you can only sell as many capsules as you
              have capped copies.
            </p>
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
                  <span className="text-subtle uppercase tracking-wider">{p.code}</span> — {p.detail}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {authRequired && (
        <p className="text-[11px] font-mono text-[#ffcf70] mb-4">
          Sign in with your wallet to publish — tap publish again.
        </p>
      )}

      <div className="flex flex-wrap gap-2 mt-8 mb-16">
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
      </div>
    </div>
  )
}

const inputClass =
  'bg-transparent border border-line px-3 py-2 text-xs font-mono text-ink placeholder:text-subtle focus:outline-none focus:border-dim min-w-0'

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-[11px] font-mono uppercase tracking-widest text-muted mb-2">{title}</h2>
      {note && <p className="text-[11px] font-mono text-subtle mb-3 max-w-xl leading-relaxed">{note}</p>}
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-mono uppercase tracking-wider text-subtle">{label}</span>
      {children}
      {hint && <span className="text-[10px] font-mono text-subtle">{hint}</span>}
    </label>
  )
}
