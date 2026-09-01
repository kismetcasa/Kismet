'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { shortAddress } from '@/lib/inprocess'

/**
 * The verifier, as a surface a person can actually use.
 *
 * A "provably fair" claim that resolves to a JSON endpoint nobody can address
 * is not a claim, it is a gesture: before this page existed the machine told
 * players their draw could be recomputed at /api/experience/verify, printed as
 * plain text, with no link and no hint that it needs a machine id, a
 * transaction hash and a unit index. The proof was real and unreachable.
 *
 * This renders the whole check: what was committed in advance, what was
 * revealed afterwards, and whether recomputing the draw from that material
 * lands on the artwork that was actually delivered. The raw material is shown
 * alongside so the recomputation can be redone independently — the endpoint's
 * own verdict is a convenience, not the evidence.
 */

interface VerifyResponse {
  verifiable: boolean
  ok?: boolean
  reason?: string
  revealsAfter?: string
  epoch?: string
  serverSeed?: string
  commitment?: string
  snapshotHash?: string
  snapshot?: { collection: string; tokenId: string; artist: string; weight: number; remaining: number | null }[]
  txHash?: string
  unitIndex?: number
  attempt?: number
  drawHash?: string
  recomputed?: { collection: string; tokenId: string } | null
  delivered?: { collection: string; tokenId: string; artist: string } | null
}

export function ExperienceVerify({ machineId, initialTx }: { machineId: string; initialTx: string }) {
  const [txHash, setTxHash] = useState(initialTx)
  const [unitIndex, setUnitIndex] = useState('0')
  const [result, setResult] = useState<VerifyResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = useCallback(
    async (tx: string, unit: string) => {
      if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) {
        setError('Enter the transaction hash of the capsule you paid for.')
        setResult(null)
        return
      }
      setBusy(true)
      setError(null)
      try {
        const r = await fetch(
          `/api/experience/verify?machineId=${encodeURIComponent(machineId)}&txHash=${encodeURIComponent(tx)}&unitIndex=${encodeURIComponent(unit || '0')}`,
        )
        const body = (await r.json().catch(() => null)) as VerifyResponse & { error?: string }
        if (!r.ok) {
          setError(body?.error ?? 'That play could not be found.')
          setResult(null)
          return
        }
        setResult(body)
      } catch {
        setError('Could not reach the verifier.')
        setResult(null)
      } finally {
        setBusy(false)
      }
    },
    [machineId],
  )

  // Auto-run when the machine page handed us a transaction, so arriving from a
  // reveal is one tap rather than a copy-paste exercise.
  useEffect(() => {
    if (initialTx) run(initialTx, '0')
  }, [initialTx, run])

  return (
    <div className="max-w-3xl mx-auto">
      <header className="mb-6">
        <h1 className="text-lg font-mono tracking-wider text-ink">verify a play</h1>
        <p className="text-[11px] font-mono text-muted mt-1">
          Recompute any finished draw on{' '}
          <Link href={`/experience/${machineId}`} className="text-dim hover:text-ink underline">
            this machine
          </Link>{' '}
          from the seed that was committed before it happened.
        </p>
      </header>

      <div className="border border-line p-4 flex flex-col sm:flex-row gap-3">
        <input
          value={txHash}
          onChange={(e) => setTxHash(e.target.value.trim())}
          placeholder="capsule transaction hash (0x…)"
          spellCheck={false}
          aria-label="Capsule transaction hash"
          className="flex-1 min-w-0 bg-transparent border border-line px-3 py-2 text-xs font-mono text-ink placeholder:text-subtle focus:outline-none focus:border-dim"
        />
        <input
          value={unitIndex}
          onChange={(e) => setUnitIndex(e.target.value.replace(/\D/g, ''))}
          placeholder="unit"
          inputMode="numeric"
          aria-label="Unit index within the capsule transaction"
          className="w-full sm:w-20 bg-transparent border border-line px-3 py-2 text-xs font-mono text-ink placeholder:text-subtle focus:outline-none focus:border-dim"
        />
        <button
          onClick={() => run(txHash, unitIndex)}
          disabled={busy}
          className="px-5 py-2 text-xs font-mono tracking-widest uppercase btn-accent disabled:opacity-40 shrink-0"
        >
          {busy ? 'checking…' : 'verify'}
        </button>
      </div>

      {error && <p className="mt-4 text-xs font-mono text-[#ff7c80]">{error}</p>}

      {result && !result.verifiable && (
        <section className="mt-6 border border-line p-4">
          <p className="text-xs font-mono text-ink">not yet verifiable</p>
          <p className="text-[11px] font-mono text-muted mt-2 max-w-lg">
            {result.reason}
            {result.revealsAfter && (
              <>
                {' '}The seed for <span className="text-dim">{result.revealsAfter}</span> is revealed once that day
                closes. Revealing it while the day is live would make every remaining draw in it predictable, so
                this wait is the feature working.
              </>
            )}
          </p>
          {result.commitment && (
            <Field label="commitment published in advance" value={result.commitment} />
          )}
          {result.snapshotHash && <Field label="weight table hash" value={result.snapshotHash} />}
        </section>
      )}

      {result?.verifiable && (
        <section className="mt-6">
          <div
            className={`border p-4 ${
              result.ok ? 'border-[#2c5a2c] bg-[#0d1a0d]' : 'border-[#5a2c2c] bg-[#1a0d0d]'
            }`}
          >
            <p className={`text-sm font-mono ${result.ok ? 'text-[#7ee787]' : 'text-[#ff7c80]'}`}>
              {result.ok ? 'verified' : 'MISMATCH'}
            </p>
            <p className="text-[11px] font-mono text-muted mt-1.5 max-w-lg">
              {result.ok ? (
                <>
                  The revealed seed matches the commitment published before this play, the lineup matches the
                  weight table committed at the draw, and recomputing the draw from both lands on the artwork
                  that was delivered.
                </>
              ) : (
                <>{result.reason ?? 'The recomputed draw does not match what was delivered.'}</>
              )}
            </p>
          </div>

          <div className="mt-4 border border-line divide-y divide-line">
            <Field label="epoch" value={result.epoch ?? ''} />
            <Field label="commitment (published first)" value={result.commitment ?? ''} />
            <Field label="server seed (revealed after)" value={result.serverSeed ?? ''} />
            <Field label="weight table hash" value={result.snapshotHash ?? ''} />
            <Field label="your transaction" value={result.txHash ?? ''} />
            <Field label="unit · attempt" value={`${result.unitIndex ?? 0} · ${result.attempt ?? 0}`} />
            <Field label="draw hash" value={result.drawHash ?? ''} />
            <Field
              label="recomputed → delivered"
              value={
                result.recomputed && result.delivered
                  ? `#${result.recomputed.tokenId} → #${result.delivered.tokenId}`
                  : '—'
              }
            />
          </div>

          {result.snapshot && result.snapshot.length > 0 && (
            <div className="mt-6">
              <h2 className="text-[11px] font-mono uppercase tracking-widest text-muted mb-2">
                the exact lineup this play drew from
              </h2>
              <div className="border border-line divide-y divide-line">
                {result.snapshot.map((e) => (
                  <div key={`${e.collection}:${e.tokenId}`} className="flex items-center gap-3 px-3 py-2">
                    <span className="flex-1 min-w-0 text-[11px] font-mono text-dim truncate">
                      #{e.tokenId} <span className="text-subtle">by {shortAddress(e.artist)}</span>
                    </span>
                    <span className="text-[10px] font-mono text-subtle tabular-nums shrink-0">
                      weight {e.weight} · {e.remaining === null ? 'unlimited' : `${e.remaining} left`}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-[10px] font-mono text-subtle mt-2 max-w-lg leading-relaxed">
                Recompute it yourself: HMAC-SHA256 the seed over{' '}
                <span className="text-dim">txHash:unitIndex:attempt</span> (lowercased hash), take the first 128
                bits as an integer, and reduce modulo the total weight above. Walking the rows in this order
                until the cumulative weight passes that number gives the winner.
              </p>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2">
      <p className="text-[10px] font-mono uppercase tracking-wider text-subtle">{label}</p>
      <p className="text-[11px] font-mono text-dim break-all mt-0.5">{value || '—'}</p>
    </div>
  )
}
