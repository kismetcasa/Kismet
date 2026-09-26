'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import type { Address } from 'viem'
import { useUpdateMomentSale } from '@/hooks/useUpdateMomentSale'
import { useUploadSession } from '@/hooks/useUploadSession'
import { toastError } from '@/lib/toast'
import { formatPrice, shortAddress } from '@/lib/inprocess'

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
      {manage && signedIn && referralPaid != null && (
        <p className="text-[11px] font-mono text-muted leading-relaxed">
          Collects through your reveal machines earn you Zora&apos;s mint referral, paid to your wallet
          automatically each day.{' '}
          <span className="text-dim">Paid so far: {formatPrice(referralPaid, 'eth')}</span>
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
                  {' · '}{m.prizes.count} {m.prizes.count === 1 ? 'prize' : 'prizes'} delivered
                </>
              )}
            </p>
            {m.kind === 'capsule' && m.prizes.recent.length > 0 && (
              <div className="mt-1.5">
                <ul className="flex flex-col gap-0.5">
                  {m.prizes.recent.map((p) => (
                    <li key={`${p.txHash}:${p.unitIndex}`} className="text-[10px] font-mono text-subtle">
                      <Link href={`/artwork/${p.collection}/${p.tokenId}`} className="text-dim hover:text-ink underline">
                        #{p.tokenId}
                      </Link>{' '}
                      won by{' '}
                      <Link href={`/profile/${p.player}`} className="hover:text-dim">
                        {shortAddress(p.player)}
                      </Link>
                    </li>
                  ))}
                </ul>
                {manage && signedIn && (
                  <p className="text-[10px] font-mono text-subtle mt-1 leading-relaxed">
                    Capsule prizes are minted by Kismet when a paid capsule is opened. They are not airdrops: they
                    don&apos;t appear in your airdrops or count toward your airdrop allowance.
                  </p>
                )}
              </div>
            )}

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
      {featuredIn.length > 0 && (
        <div className="mt-2">
          <p className="text-[10px] font-mono uppercase tracking-widest text-muted mb-1.5">
            {manage ? 'your work in other machines' : 'featured in'}
          </p>
          <ul className="flex flex-col gap-1">
            {featuredIn.map((f) => (
              <li key={f.id} className="text-[11px] font-mono text-subtle">
                <Link href={`/experience/${f.id}`} className="text-dim hover:text-ink underline">
                  {f.name}
                </Link>{' '}
                · curated by{' '}
                <Link href={`/profile/${f.curator}`} className="hover:text-dim">
                  {shortAddress(f.curator)}
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
        <Link href="/experience/new" className="self-start text-[11px] font-mono text-dim hover:text-ink underline mt-1">
          open another machine →
        </Link>
      )}
    </div>
  )
}
