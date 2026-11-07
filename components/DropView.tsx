'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useAccount } from 'wagmi'
import { toast } from 'sonner'
import {
  arkivEntityUrl,
  isDropOpen,
  recordExpiresAt,
  settlementRecipients,
  swarmGatewayUrl,
  type ClaimView,
  type DropView as DropData,
  type SettlementView,
} from '@/lib/drops'
import { KISMET_CHANNEL_KEY } from '@/lib/collectShare'
import { DropCountdown } from '@/components/DropCountdown'
import { DropSettle } from '@/components/DropSettle'
import { useDropIntents } from '@/hooks/useDropIntents'
import { useEnsureConnected } from '@/hooks/useEnsureConnected'
import { useProfileNames } from '@/hooks/useProfileNames'
import { useFarcaster } from '@/providers/FarcasterProvider'
import { toastError } from '@/lib/toast'

interface DropResponse {
  drop: DropData
  claims: ClaimView[]
  settlement: SettlementView | null
  viewerClaimed: boolean
}

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/**
 * One claim drop. Everything on this page is read from Arkiv through
 * /api/drops/{key}: the drop entity (its terms are readonly), the claims,
 * and — once the artist has delivered — the settlement linking the drop to
 * its Base token. The artwork streams from Swarm. After the window closes,
 * the artist delivers from here (components/DropSettle); every claimer then
 * sees where their copy is.
 */
export function DropView({ dropKey }: { dropKey: string }) {
  const { address } = useAccount()
  const { isInMiniApp } = useFarcaster()
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

  // While open: refresh the count every 15s (reads are cached server-side),
  // and flip to closed at the closing second itself — a Claim button must not
  // outlive the window by a poll interval.
  const closesAt = data?.drop.closesAt
  const open = closesAt !== undefined && isDropOpen(closesAt, now)
  useEffect(() => {
    if (!open || closesAt === undefined) return
    const poll = setInterval(() => void load(), 15_000)
    const close = setTimeout(
      () => {
        setNow(Math.floor(Date.now() / 1000))
        void load()
      },
      Math.max(0, closesAt * 1000 - Date.now()) + 250,
    )
    return () => {
      clearInterval(poll)
      clearTimeout(close)
    }
  }, [open, closesAt, load])

  const names = useProfileNames(data ? [data.drop.artist, ...data.claims.map((c) => c.owner)] : [])

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
      const json = (await res.json().catch(() => ({}))) as { already?: boolean; error?: string }
      if (!res.ok) throw new Error(json.error ?? 'Claim failed')
      toast.success(json.already ? 'You already claimed this drop' : 'Claimed — your copy arrives when the artist delivers')
      await load()
    } catch (err) {
      toastError('Claim', err, { id: 'claim-drop' })
    } finally {
      setClaiming(false)
    }
  }

  // Mini App → the cast composer (the drop page renders as a card with a
  // Claim button); share-capable browsers → the native sheet; else copy.
  async function share() {
    if (!data) return
    const url = `${window.location.origin}/drops/${data.drop.key}`
    const mine = address?.toLowerCase() === data.drop.artist
    const text = mine
      ? `My drop "${data.drop.title}" is open on @kismet — claim it free`
      : `Claim "${data.drop.title}" free on @kismet`
    if (isInMiniApp) {
      try {
        const { sdk } = await import('@farcaster/miniapp-sdk')
        await sdk.actions.composeCast({ text, embeds: [url], channelKey: KISMET_CHANNEL_KEY })
        return
      } catch {}
    }
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: data.drop.title, text, url })
      } catch {}
      return
    }
    try {
      await navigator.clipboard.writeText(url)
      toast.success('Link copied', { id: 'drop-share' })
    } catch {}
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

  const { drop, claims, settlement, viewerClaimed } = data
  const viewer = address?.toLowerCase() ?? null
  const isArtist = viewer === drop.artist
  const full = drop.claimCount >= drop.maxClaims
  const expiresOn = new Date(recordExpiresAt(drop.closesAt) * 1000).toLocaleDateString()
  const artworkHref = settlement ? `/artwork/${settlement.collection.toLowerCase()}/${settlement.tokenId}` : null

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

      <div className="flex items-center justify-between gap-3 border-y border-line py-3 text-xs font-mono">
        <span className="text-ink">
          {drop.claimCount} / {drop.maxClaims} claimed
        </span>
        <span className="flex items-center gap-3">
          {settlement ? (
            <span className="text-ink">delivered ✓</span>
          ) : (
            <DropCountdown closesAt={drop.closesAt} className={open ? 'text-accent' : 'text-muted'} />
          )}
          {open && (
            <button type="button" onClick={() => void share()} className="underline text-muted hover:text-ink">
              share
            </button>
          )}
        </span>
      </div>

      {open && !isArtist && (
        viewerClaimed ? (
          <p className="text-center text-xs font-mono text-ink border border-line py-3">
            Claimed ✓ — your copy is airdropped when the artist delivers
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
          This is your drop. Share it — when it closes you&apos;ll deliver it to every claimer from this page.
        </p>
      )}

      {settlement && artworkHref && (
        <div className="border border-line p-3 flex flex-col gap-1 text-xs font-mono">
          <p className="text-ink">
            {viewerClaimed
              ? 'Delivered ✓ — your copy is in your wallet.'
              : isArtist
                ? `Delivered ✓ — airdropped to ${settlement.recipients} ${settlement.recipients === 1 ? 'wallet' : 'wallets'}.`
                : `Delivered to ${settlement.recipients} ${settlement.recipients === 1 ? 'wallet' : 'wallets'}.`}
          </p>
          <p className="text-muted">
            <Link href={artworkHref} className="underline hover:text-ink">View the artwork</Link>
            {' · '}
            <a
              href={`https://basescan.org/tx/${settlement.airdropTx}`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-ink"
            >
              airdrop on Base
            </a>
          </p>
        </div>
      )}

      {!open && !settlement && !isArtist && (
        <p className="text-center text-xs font-mono text-muted border border-line py-3">
          {viewerClaimed ? 'Claims closed — your copy arrives when the artist delivers' : 'Claims closed'}
        </p>
      )}

      {!open && !settlement && isArtist && (
        claims.length > 0 ? (
          <DropSettle
            dropKey={drop.key}
            artist={drop.artist}
            claimCount={claims.length}
            editionSize={settlementRecipients(claims, drop.artist).length}
            onDelivered={() => void load()}
          />
        ) : (
          <p className="text-xs font-mono text-muted border border-line p-3">
            Nobody claimed this drop, so there is nothing to deliver.
          </p>
        )
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
              href={swarmGatewayUrl(drop.swarmRef)}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              {drop.swarmRef}
            </a>
          </p>
          {settlement && (
            <p>
              Settlement entity:{' '}
              <a href={arkivEntityUrl(settlement.key)} target="_blank" rel="noopener noreferrer" className="underline">
                {short(settlement.key)}
              </a>{' '}
              — links this drop to its token on Base.
            </p>
          )}
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
