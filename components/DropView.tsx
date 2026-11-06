'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useAccount } from 'wagmi'
import { toast } from 'sonner'
import {
  arkivEntityUrl,
  dropPhase,
  recordExpiresAt,
  settlementRecipients,
  type ClaimView,
  type DropView as DropData,
} from '@/lib/drops'
import { DropCountdown } from '@/components/DropCountdown'
import { useDropIntents } from '@/hooks/useDropIntents'
import { useEnsureConnected } from '@/hooks/useEnsureConnected'
import { useProfileNames } from '@/hooks/useProfileNames'
import { toastError } from '@/lib/toast'

interface DropResponse {
  drop: DropData
  claims: ClaimView[]
  viewerClaimed: boolean
}

const SWARM_GATEWAY = 'https://api.gateway.ethswarm.org'

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/**
 * One claim drop. Everything on this page is read from Arkiv through
 * /api/drops/{key}: the drop entity (its terms are readonly), the claim count
 * and the list of claims. The artwork streams from Swarm. After the window
 * closes, the artist sees what to do next: mint once, then airdrop to the
 * claim list (prefilled from Arkiv on the airdrop tab).
 */
export function DropView({ dropKey }: { dropKey: string }) {
  const { address } = useAccount()
  const ensureConnected = useEnsureConnected()
  const { signClaimDrop } = useDropIntents()

  const [data, setData] = useState<DropResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [claiming, setClaiming] = useState(false)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  const load = useCallback(async () => {
    try {
      const qs = address ? `?viewer=${address}` : ''
      const res = await fetch(`/api/drops/${dropKey}${qs}`, { cache: 'no-store' })
      const json = (await res.json().catch(() => ({}))) as Partial<DropResponse> & { error?: string }
      if (!res.ok || !json.drop) {
        setError(json.error ?? 'Could not load this drop')
        return
      }
      setError(null)
      setData(json as DropResponse)
    } catch {
      setError('Could not load this drop')
    }
  }, [dropKey, address])

  useEffect(() => {
    void load()
  }, [load])

  // Keep the count fresh while the drop is open.
  const open = data ? dropPhase(data.drop.closesAt, now) === 'open' : false
  useEffect(() => {
    if (!open) return
    const id = setInterval(() => {
      setNow(Math.floor(Date.now() / 1000))
      void load()
    }, 15_000)
    return () => clearInterval(id)
  }, [open, load])

  const names = useProfileNames(data ? [data.drop.artist, ...data.claims.map((c) => c.owner)] : [])
  const recipients = useMemo(() => (data ? settlementRecipients(data.claims) : []), [data])

  async function claim() {
    if (!data || claiming) return
    const account = await ensureConnected()
    if (!account) return
    setClaiming(true)
    try {
      const intent = await signClaimDrop(account, data.drop.key)
      const res = await fetch(`/api/drops/${data.drop.key}/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account, intent }),
      })
      const json = (await res.json().catch(() => ({}))) as { claimKey?: string; already?: boolean; error?: string }
      if (!res.ok) throw new Error(json.error ?? 'Claim failed')
      toast.success(json.already ? 'You already claimed this drop' : 'Claimed — your copy arrives when the drop settles')
      await load()
    } catch (err) {
      toastError('Claim', err, { id: 'claim-drop' })
    } finally {
      setClaiming(false)
    }
  }

  if (error && !data) {
    return (
      <div className="text-center py-20">
        <p className="text-sm text-muted font-mono mb-4">{error}</p>
        <Link href="/drops" className="text-xs font-mono underline text-muted hover:text-ink">All drops</Link>
      </div>
    )
  }
  if (!data) {
    return <div className="py-20 text-center text-xs font-mono text-muted">Loading drop from Arkiv…</div>
  }

  const { drop, claims, viewerClaimed } = data
  const viewer = address?.toLowerCase() ?? null
  const isArtist = viewer === drop.artist
  const full = drop.claimCount >= drop.maxClaims
  const expiresOn = new Date(recordExpiresAt(drop.closesAt) * 1000).toLocaleDateString()

  return (
    <div className="flex flex-col gap-8">
      {/* eslint-disable-next-line @next/next/no-img-element -- streamed from Swarm via /api/drops/{key}/media */}
      <img
        src={`/api/drops/${drop.key}/media`}
        alt={drop.title}
        className="w-full max-h-[560px] object-contain bg-[#0a0a0a] border border-line"
      />

      <div className="flex flex-col gap-2">
        <h1 className="text-lg text-ink">{drop.title}</h1>
        <p className="text-xs font-mono text-muted">
          by{' '}
          <Link href={`/profile/${drop.artist}`} className="underline hover:text-ink">
            {names(drop.artist)}
          </Link>
        </p>
        {drop.description && <p className="text-sm text-muted whitespace-pre-line">{drop.description}</p>}
      </div>

      <div className="flex items-center justify-between border-y border-line py-3 text-xs font-mono">
        <span className="text-ink">
          {drop.claimCount} / {drop.maxClaims} claimed
        </span>
        <DropCountdown closesAt={drop.closesAt} className={open ? 'text-accent' : 'text-muted'} />
      </div>

      {open && !isArtist && (
        viewerClaimed ? (
          <p className="text-center text-xs font-mono text-ink border border-line py-3">
            Claimed ✓ — your copy is airdropped when the drop settles
          </p>
        ) : full ? (
          <p className="text-center text-xs font-mono text-muted border border-line py-3">All claims are taken</p>
        ) : (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={claim}
              disabled={claiming}
              className="w-full py-3 text-xs font-mono tracking-widest uppercase btn-accent"
            >
              {claiming ? 'Sign in your wallet…' : 'Claim — free'}
            </button>
            <p className="text-[11px] text-muted text-center">
              One signature. No gas, no fee — you don&apos;t need ETH.
            </p>
          </div>
        )
      )}

      {open && isArtist && (
        <p className="text-xs font-mono text-muted border border-line p-3">
          This is your drop. Share this page — when it closes you&apos;ll mint it and airdrop to every claim.
        </p>
      )}

      {!open && !isArtist && (
        <p className="text-center text-xs font-mono text-muted border border-line py-3">
          {viewerClaimed ? 'Claims closed — your copy is on its way when the artist settles' : 'Claims closed'}
        </p>
      )}

      {!open && isArtist && (
        <div className="border border-accent/40 bg-accent/5 p-4 flex flex-col gap-3">
          <h2 className="text-xs font-mono uppercase tracking-widest text-ink">Settle this drop</h2>
          <p className="text-xs text-muted">
            {recipients.length} {recipients.length === 1 ? 'claim' : 'claims'} to deliver. The drop and its claims stay on
            Arkiv until {expiresOn}.
          </p>
          <ol className="text-xs text-muted list-decimal pl-4 flex flex-col gap-2">
            <li>
              <Link href="/mint" className="underline text-ink">Mint the artwork</Link> as usual.{' '}
              <a href={`/api/drops/${drop.key}/media`} download className="underline">Download the image</a> if you
              need it again.
            </li>
            <li>
              <Link href={`/mint?tab=airdrop&drop=${drop.key}`} className="underline text-ink">
                Airdrop it to the {recipients.length} {recipients.length === 1 ? 'claimer' : 'claimers'}
              </Link>{' '}
              — the list is filled in from Arkiv. An airdrop carries no mint fee, only a little Base gas.
            </li>
          </ol>
        </div>
      )}

      <details className="text-xs font-mono text-muted border border-line p-3">
        <summary className="cursor-pointer text-ink">On Arkiv and Swarm</summary>
        <div className="mt-3 flex flex-col gap-2 break-all">
          <p>
            Drop entity:{' '}
            <a href={arkivEntityUrl(drop.key)} target="_blank" rel="noopener noreferrer" className="underline">
              {drop.key}
            </a>{' '}
            — read-only, owned by the artist, expires {expiresOn}.
          </p>
          <p>
            Artwork on Swarm:{' '}
            <a
              href={`${SWARM_GATEWAY}/bzz/${drop.swarmRef}/`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              {drop.swarmRef}
            </a>
          </p>
          {claims.length > 0 && (
            <div>
              <p className="mb-1">Claims ({claims.length}), each owned by its collector:</p>
              <ul className="flex flex-col gap-1">
                {claims.map((c) => (
                  <li key={c.key}>
                    <a href={arkivEntityUrl(c.key)} target="_blank" rel="noopener noreferrer" className="underline">
                      {short(c.key)}
                    </a>{' '}
                    → {names(c.owner)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </details>
    </div>
  )
}
