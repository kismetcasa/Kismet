'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import type { Address } from 'viem'
import { useUpdateMomentSale } from '@/hooks/useUpdateMomentSale'
import { useUploadSession } from '@/hooks/useUploadSession'
import { toastError } from '@/lib/toast'

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
}

export type CreatorMachine =
  | (CreatorMachineCommon & {
      kind: 'capsule'
      capsule: { collection: string; tokenId: string }
      plays: number
      capsules: { maxSupply: number | null; minted: number } | null
    })
  | (CreatorMachineCommon & { kind: 'reveal'; pieces: number })

/** Loaded once by the profile, which shows the section only when there is
 *  something in it. `owner` is the SERVER's verdict — true only when the
 *  signed-in session is this creator, which is what gates non-public states. */
export function useCreatorMachines(address: string) {
  const [machines, setMachines] = useState<CreatorMachine[]>([])
  const [owner, setOwner] = useState(false)
  const reload = useCallback(() => {
    fetch(`/api/experience/machines?creator=${address}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { owner: boolean; machines: CreatorMachine[] } | null) => {
        setMachines(d?.machines ?? [])
        setOwner(d?.owner === true)
      })
      .catch(() => {})
  }, [address])
  useEffect(() => {
    setMachines([])
    setOwner(false)
    reload()
  }, [reload])
  return { machines, owner, reload }
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

export function ProfileMachines({
  machines,
  manage,
  signedIn,
  onChange,
}: {
  machines: CreatorMachine[]
  /** The profile belongs to the connected wallet. */
  manage: boolean
  /** The server recognised the session as this creator's. */
  signedIn: boolean
  onChange: () => void
}) {
  const { ensureSession } = useUploadSession()
  const { endNow } = useUpdateMomentSale()
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const act = async (m: CreatorMachine, action: 'end' | 'withdraw') => {
    setBusy(m.id)
    try {
      await ensureSession()
      if (action === 'end' && m.kind === 'capsule') {
        // The on-chain sale first: it is what actually stops capsules being
        // bought, here or on zora.co. Our record only stops the listing. An
        // already-closed sale is a no-op that needs no signature. A reveal
        // machine has no sale of its own; closing it is the listing alone.
        await endNow({ collection: m.capsule.collection as Address, tokenId: BigInt(m.capsule.tokenId) })
      }
      const r = await fetch(`/api/experience/machines/${m.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const body = await r.json().catch(() => null)
      if (!r.ok) {
        toast.error(body?.error ?? 'Could not update this machine')
        return
      }
      toast.success(action === 'end' ? (m.kind === 'reveal' ? 'Machine closed' : 'Season ended') : 'Machine withdrawn')
      setConfirming(null)
      onChange()
    } catch (err) {
      toastError(action === 'end' ? 'End season' : 'Withdraw', err)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {manage && !signedIn && (
        <button
          onClick={() => void ensureSession({ revalidate: true }).then(onChange).catch(() => {})}
          className="self-start text-[11px] font-mono text-dim hover:text-ink underline"
        >
          sign in to see machines waiting for review
        </button>
      )}
      {machines.map((m) => {
        const onShelf = m.state !== 'draft' && m.state !== 'review'
        const key = (a: string) => `${m.id}:${a}`
        return (
          <div key={m.id} className="border border-line px-4 py-3">
            <div className="flex items-center gap-3">
              {onShelf ? (
                <Link href={`/experience/${m.id}`} className="flex-1 min-w-0 text-sm font-mono text-ink hover:underline truncate">
                  {m.name}
                </Link>
              ) : (
                <span className="flex-1 min-w-0 text-sm font-mono text-ink truncate">{m.name}</span>
              )}
              <span
                className={`text-[10px] font-mono uppercase tracking-wider shrink-0 ${
                  m.state === 'live' ? 'text-accent' : 'text-subtle'
                }`}
              >
                {m.state}
              </span>
            </div>
            <p className="text-[10px] font-mono text-muted mt-1">
              {signedIn ? `${(m.kind === 'reveal' ? REVEAL_STATUS : STATUS)[m.state]} · ` : ''}
              {m.kind === 'reveal' ? (
                <>reveal machine · {m.pieces} {m.pieces === 1 ? 'artwork' : 'artworks'}</>
              ) : (
                <>
                  {m.plays} {m.plays === 1 ? 'play' : 'plays'}
                  {m.capsules && (
                    <> · {m.capsules.minted}{m.capsules.maxSupply === null ? '' : ` of ${m.capsules.maxSupply}`} capsules minted</>
                  )}
                </>
              )}
            </p>

            {manage && signedIn && (m.state === 'live' || m.withdrawable) && (
              confirming === key(m.state === 'live' ? 'end' : 'withdraw') ? (
                <div className="mt-2 border-t border-line pt-2">
                  <p className="text-[11px] font-mono text-muted leading-relaxed">
                    {m.state === 'live'
                      ? m.kind === 'reveal'
                        ? 'This takes the machine off the shelves. Its artworks stay on sale on their own pages.'
                        : 'This ends the capsule’s sale on-chain (one signature) and closes the season. Every capsule already sold is still honoured.'
                      : m.kind === 'reveal'
                        ? 'This takes the machine back and frees its id, so you can fix it and publish again.'
                        : 'This takes the machine back. Its id, its capsule and the editions it held are freed, so you can fix it and publish again.'}
                  </p>
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={() => void act(m, m.state === 'live' ? 'end' : 'withdraw')}
                      disabled={busy === m.id}
                      className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider btn-accent disabled:opacity-40"
                    >
                      {busy === m.id ? 'working…' : m.state === 'live' ? (m.kind === 'reveal' ? 'confirm close' : 'confirm end season') : 'confirm withdraw'}
                    </button>
                    <button
                      onClick={() => setConfirming(null)}
                      disabled={busy === m.id}
                      className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider border border-line text-dim hover:text-ink disabled:opacity-40"
                    >
                      cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setConfirming(key(m.state === 'live' ? 'end' : 'withdraw'))}
                  className="mt-2 text-[11px] font-mono text-dim hover:text-ink underline"
                >
                  {m.state === 'live' ? (m.kind === 'reveal' ? 'close machine' : 'end season') : 'withdraw'}
                </button>
              )
            )}
          </div>
        )
      })}
      {manage && (
        <Link href="/experience/new" className="self-start text-[11px] font-mono text-dim hover:text-ink underline mt-1">
          open another machine →
        </Link>
      )}
    </div>
  )
}
