'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useAccount } from '@/hooks/useAccount'
import { type DropView, type SettlementView } from '@/lib/drops'
import { DropCountdown } from '@/components/DropCountdown'
import { useProfileNames } from '@/hooks/useProfileNames'

interface DropsResponse {
  open: DropView[]
  settling: DropView[]
}

interface OwnedClaim {
  claimKey: string
  dropKey: string
  title: string
  artist: string
  closesAt: number
  settlement: SettlementView | null
}

function DropCard({ drop, artistName }: { drop: DropView; artistName: string }) {
  return (
    <Link href={`/drops/${drop.key}`} className="block border border-line hover:border-muted transition-colors">
      {/* eslint-disable-next-line @next/next/no-img-element -- streamed from Swarm via /api/drops/{key}/media */}
      <img
        src={`/api/drops/${drop.key}/media`}
        alt={drop.title}
        loading="lazy"
        className="w-full aspect-square object-cover bg-[#0a0a0a]"
      />
      <div className="p-3 flex flex-col gap-1">
        <span className="text-sm text-ink truncate">{drop.title}</span>
        <span className="text-[11px] font-mono text-muted truncate">{artistName}</span>
        <div className="flex items-center justify-between text-[11px] font-mono mt-1">
          <span className="text-muted">
            {drop.claimCount}/{drop.maxClaims} claimed
          </span>
          {drop.delivered ? (
            <span className="text-ink">delivered ✓</span>
          ) : (
            <DropCountdown closesAt={drop.closesAt} className="text-accent" />
          )}
        </div>
      </div>
    </Link>
  )
}

/** Where one of the viewer's claims stands, in a line. */
function ClaimRow({ claim, artistName, nowSec }: { claim: OwnedClaim; artistName: string; nowSec: number }) {
  const s = claim.settlement
  return (
    <li className="flex items-center justify-between gap-3 border-b border-line py-2 text-xs font-mono">
      <Link href={`/drops/${claim.dropKey}`} className="min-w-0 truncate text-ink hover:underline">
        {claim.title} <span className="text-muted">· {artistName}</span>
      </Link>
      {s ? (
        <Link href={`/artwork/${s.collection.toLowerCase()}/${s.tokenId}`} className="shrink-0 text-ink underline">
          delivered ✓
        </Link>
      ) : nowSec < claim.closesAt ? (
        <DropCountdown closesAt={claim.closesAt} className="shrink-0 text-accent" />
      ) : (
        <span className="shrink-0 text-muted">waiting for the artist</span>
      )}
    </li>
  )
}

/**
 * The drops index: open drops soonest-closing first, then drops waiting for
 * their artist to deliver. Both lists are Arkiv queries (GET /api/drops), so
 * any other app can build the same feed — the query is written out in
 * arkiv/how-you-use-arkiv.md. With a wallet connected, its claims come first
 * (GET /api/drops/claims — an `ownedBy` query), each with where it stands.
 */
export function DropsFeed() {
  const { address } = useAccount()
  const [data, setData] = useState<DropsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mine, setMine] = useState<OwnedClaim[]>([])
  // Open vs closed for the claim rows, as of page load (DropCountdown ticks).
  const [nowSec] = useState(() => Math.floor(Date.now() / 1000))

  useEffect(() => {
    let cancelled = false
    fetch('/api/drops', { cache: 'no-store' })
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as Partial<DropsResponse> & { error?: string }
        if (cancelled) return
        if (!res.ok || !json.open) setError(json.error ?? 'Could not load drops')
        else setData({ open: json.open, settling: json.settling ?? [] })
      })
      .catch(() => !cancelled && setError('Could not load drops'))
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    setMine([])
    if (!address) return
    let cancelled = false
    fetch(`/api/drops/claims?owner=${address}`, { cache: 'no-store' })
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as { claims?: OwnedClaim[] }
        if (!cancelled && res.ok && json.claims) setMine(json.claims)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [address])

  const names = useProfileNames([...(data ? [...data.open, ...data.settling] : []), ...mine].map((d) => d.artist))

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-sm font-mono text-ink uppercase tracking-widest mb-2">Claim drops</h1>
          <p className="text-xs text-muted max-w-md leading-relaxed">
            Free to claim with one signature — no gas, no fee, no ETH. When a drop closes, its artist delivers it:
            the artwork is minted and airdropped to every claim.
          </p>
        </div>
        <Link
          href="/drops/new"
          className="self-start sm:self-auto px-4 py-2 text-xs font-mono tracking-widest uppercase border border-accent/40 text-accent hover:border-accent hover:bg-accent/10 transition-colors"
        >
          Open a drop
        </Link>
      </div>

      {error && <p className="text-xs font-mono text-muted">{error}</p>}
      {!data && !error && <p className="text-xs font-mono text-muted">Loading drops from Arkiv…</p>}

      {mine.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-mono text-muted uppercase tracking-wider">Your claims</h2>
          <ul className="flex flex-col">
            {mine.map((c) => (
              <ClaimRow key={c.claimKey} claim={c} artistName={names(c.artist)} nowSec={nowSec} />
            ))}
          </ul>
        </section>
      )}

      {data && (
        <>
          <section className="flex flex-col gap-3">
            <h2 className="text-xs font-mono text-muted uppercase tracking-wider">Open now</h2>
            {data.open.length === 0 ? (
              <p className="text-xs text-muted">No open drops right now.</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {data.open.map((d) => (
                  <DropCard key={d.key} drop={d} artistName={names(d.artist)} />
                ))}
              </div>
            )}
          </section>

          {data.settling.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-xs font-mono text-muted uppercase tracking-wider">Closed</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {data.settling.map((d) => (
                  <DropCard key={d.key} drop={d} artistName={names(d.artist)} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <p className="text-[11px] font-mono text-muted border-t border-line pt-4">
        Live from Arkiv (Rabdi testnet): drops and claims are public entities any app can query. Artwork is stored on
        Swarm.
      </p>
    </div>
  )
}
