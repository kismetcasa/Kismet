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
import { MAX_POOL_ENTRIES } from '@/lib/experience/draw'
import { parseArtworkRef } from '@/lib/experience/format'
import type { LineupPiece, SolvencyProblemCode } from '@/lib/experience/types'
import { formatPrice, shortAddress } from '@/lib/inprocess'
import { DetailWithLinks, Field, Section, StudioSubmitted, inputClass, pieceKey } from './CapsuleStudio'

/**
 * Build a reveal machine: a name and a lineup of anyone's artworks.
 *
 * There is nothing to price or back. A pull is free and a player collects what
 * it reveals through that piece's own sale, so the only things to get right
 * are whose work each piece is and whether its artist has said no — both shown
 * per row as the curator pastes, before any check runs.
 */

interface Row {
  collection: string
  tokenId: string
}

type Standing = { available: boolean | null; artist: string | null } | 'loading'

const STATUS: Record<LineupPiece['status'], string> = {
  'on-sale': 'on sale now',
  'not-on-sale': 'shows up when its sale opens',
  'sold-out': 'sold out',
  unavailable: 'not available',
  unreadable: 'could not read its sale just now',
}

export function RevealStudio() {
  const router = useRouter()
  const { address } = useAccount()
  const { ensureSession } = useUploadSession()
  const ensureConnected = useEnsureConnected()
  const { gatedOut, passCollectionHref, passCollectionName } = usePassGate()

  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [rows, setRows] = useState<Row[]>([{ collection: '', tokenId: '' }])
  const [pieces, setPieces] = useState<Record<string, Standing>>({})
  const [problems, setProblems] = useState<{ code: SolvencyProblemCode; detail: string }[] | null>(null)
  const [lineup, setLineup] = useState<Record<string, LineupPiece>>({})
  const [busy, setBusy] = useState<'check' | 'publish' | null>(null)
  const [authRequired, setAuthRequired] = useState(false)
  const [submitted, setSubmitted] = useState<{ id: string; name: string } | null>(null)

  const complete = useMemo(() => rows.filter((r) => isAddress(r.collection) && /^\d+$/.test(r.tokenId)), [rows])

  useEffect(() => {
    for (const r of complete) {
      const key = pieceKey(r)
      if (pieces[key] !== undefined) continue
      setPieces((p) => ({ ...p, [key]: 'loading' }))
      fetch(`/api/experience/piece?collection=${r.collection}&tokenId=${r.tokenId}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((d: { available: boolean | null; artist: string | null } | null) =>
          setPieces((p) => ({ ...p, [key]: { available: d?.available ?? null, artist: d?.artist ?? null } })),
        )
        .catch(() => setPieces((p) => ({ ...p, [key]: { available: null, artist: null } })))
    }
  }, [complete, pieces])

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, j) => (i === j ? { ...r, ...patch } : r)))

  const submit = useCallback(
    async (dryRun: boolean) => {
      setBusy(dryRun ? 'check' : 'publish')
      try {
        await ensureSession({ revalidate: authRequired })
        setAuthRequired(false)
        const r = await fetch('/api/experience/machines', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind: 'reveal',
            id: id.trim().toLowerCase(),
            name: name.trim(),
            entries: complete.map((c) => ({ collection: c.collection.toLowerCase(), tokenId: c.tokenId })),
            dryRun,
          }),
        })
        const body = await r.json().catch(() => null)
        if (r.status === 401) { setAuthRequired(true); return }
        if (Array.isArray(body?.problems)) {
          setProblems(body.problems)
          if (Array.isArray(body.lineup)) {
            setLineup(Object.fromEntries((body.lineup as LineupPiece[]).map((p) => [p.key, p])))
          }
          if (body.problems.length === 0 && dryRun) toast.success('Ready to publish')
          if (!body.machine) return
        }
        if (!r.ok) {
          toast.error(body?.error ?? 'Could not validate this machine')
          return
        }
        if (!dryRun && body?.machine) {
          if (body.machine.state === 'live') {
            toast.success('Machine is live')
            router.push(`/experience/${body.machine.id}`)
            return
          }
          toast.success('Submitted for review')
          setSubmitted({ id: body.machine.id, name: body.machine.name })
        }
      } catch {
        toast.error(dryRun ? 'Could not validate' : 'Could not publish')
      } finally {
        setBusy(null)
      }
    },
    [authRequired, complete, ensureSession, id, name, router],
  )

  if (submitted) return <StudioSubmitted title="reveal studio" machine={submitted} address={address} />

  return (
    <div className="max-w-3xl mx-auto">
      <header className="mb-6">
        <h1 className="text-lg font-mono tracking-wider text-ink">reveal studio</h1>
        <p className="text-[11px] font-mono text-muted mt-1 max-w-xl leading-relaxed">
          Curate a machine from any artist&apos;s work on Kismet. Players pull for free, see one piece, and
          collect it at its own price — the artist is paid through that piece&apos;s own sale. Every piece
          on sale is equally likely; one that sells out or closes leaves the machine by itself. Artists can
          turn machines off for any piece from its page.
        </p>
      </header>

      {gatedOut && (
        <div className="border border-line p-4 mb-6">
          <p className="text-xs font-mono text-ink">a Kismet Pass is required to open a machine</p>
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
            placeholder="new-voices"
            className={inputClass}
          />
        </Field>
        <Field label="name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New Voices" className={inputClass} />
        </Field>
      </Section>

      <Section title="the lineup" note="Paste an artwork's link, or its collection and token id.">
        <div className="flex flex-col gap-2">
          {rows.map((r, i) => {
            const standing = pieces[pieceKey(r)]
            const live = lineup[pieceKey(r)]
            return (
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
                  <input
                    value={r.tokenId}
                    onChange={(e) => setRow(i, { tokenId: e.target.value.replace(/\D/g, '') })}
                    placeholder="token"
                    inputMode="numeric"
                    aria-label={`Artwork ${i + 1}: token id`}
                    className={`${inputClass} w-20`}
                  />
                  <button
                    onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                    aria-label={`Remove artwork ${i + 1}`}
                    className="px-2 text-[10px] font-mono text-subtle hover:text-[#ff7c80]"
                  >
                    remove
                  </button>
                </div>
                {standing && standing !== 'loading' && (
                  standing.available === false ? (
                    <p className="text-[10px] font-mono text-[#ffcf70]">Its artist has turned machines off for this piece.</p>
                  ) : standing.artist === null ? (
                    <p className="text-[10px] font-mono text-[#ffcf70]">
                      Kismet has no record of who made this — only artworks minted on Kismet can go in.
                    </p>
                  ) : (
                    <p className="text-[10px] font-mono text-subtle">
                      by {shortAddress(standing.artist)}
                      {live && (
                        <> · {STATUS[live.status]}{live.sale && ` · ${formatPrice(live.sale.pricePerToken, live.sale.currency)}`}</>
                      )}
                    </p>
                  )
                )}
              </div>
            )
          })}
        </div>
        <button
          onClick={() => setRows((rs) => (rs.length < MAX_POOL_ENTRIES ? [...rs, { collection: '', tokenId: '' }] : rs))}
          className="self-start px-4 py-2 text-[10px] font-mono uppercase tracking-wider border border-line text-dim hover:text-ink"
        >
          add artwork
        </button>
      </Section>

      {problems && (
        <Section title={problems.length === 0 ? 'ready' : 'fix before publishing'}>
          {problems.length === 0 ? (
            <p className="text-[11px] font-mono text-[#7ee787]">
              Every piece can go in. Players will see the ones on sale right now.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {problems.map((p, i) => (
                <li key={i} className="text-[11px] font-mono text-[#ff7c80]">
                  <DetailWithLinks text={p.detail} />
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {authRequired && (
        <p className="text-[11px] font-mono text-[#ffcf70] mb-4">Sign in with your wallet and try again.</p>
      )}

      <div className="flex flex-wrap gap-2 mt-8 mb-16">
        {!address ? (
          <button onClick={() => void ensureConnected()} className="px-5 py-2.5 text-xs font-mono tracking-widest uppercase btn-accent">
            connect wallet
          </button>
        ) : (
          <>
            <button
              onClick={() => submit(true)}
              disabled={busy !== null || complete.length === 0}
              className="px-5 py-2.5 text-xs font-mono tracking-widest uppercase border border-line text-dim hover:text-ink disabled:opacity-40"
            >
              {busy === 'check' ? 'checking…' : 'check'}
            </button>
            <button
              onClick={() => submit(false)}
              disabled={busy !== null || complete.length === 0 || gatedOut}
              className="px-5 py-2.5 text-xs font-mono tracking-widest uppercase btn-accent disabled:opacity-40"
            >
              {busy === 'publish' ? 'publishing…' : 'publish'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
