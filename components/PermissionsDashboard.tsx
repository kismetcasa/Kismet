'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { ArrowLeft, ShieldCheck, ShieldAlert, ShieldQuestion } from 'lucide-react'
import { shortAddress } from '@/lib/inprocess'
import { MomentImage } from './MomentImage'
import { useCollectionsPermissions } from '@/hooks/useCollectionsPermissions'
import { useInprocessSmartWallet } from '@/hooks/useInprocessSmartWallet'

interface CollectionItem {
  address: string
  name: string
  image?: string
  description?: string
  kismet_thumbhash?: string
}

/**
 * One-stop dashboard for an artist's collection permissions. Lists
 * every collection the connected wallet has deployed and renders a
 * per-row status badge:
 *
 *   ✅ ready    — smart wallet has ADMIN; collection is mint-ready
 *   ⚠️ authorize — smart wallet missing ADMIN; row links to the
 *                  collection page where the Authorize banner lives
 *   ⏳ checking — read in flight, or RPC errored (treated as unknown)
 */
export function PermissionsDashboard() {
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { address: smartWallet, loading: smartWalletLoading } =
    useInprocessSmartWallet(address)

  const [collections, setCollections] = useState<CollectionItem[]>([])
  const [loadingCollections, setLoadingCollections] = useState(false)
  const [fetched, setFetched] = useState(false)

  // Reset when wallet changes — we don't want a stale list from a
  // previously-connected EOA showing up under a freshly-connected one.
  useEffect(() => {
    setCollections([])
    setFetched(false)
  }, [address])

  // Fetch the user's tracked collections. Same endpoint MintForm uses
  // (creator-aware; includes user's hidden collections), so the lists
  // stay in lockstep across surfaces.
  useEffect(() => {
    if (!address) return
    let cancelled = false
    setLoadingCollections(true)
    fetch(`/api/collections?artist=${address}`)
      .then((r) => (r.ok ? r.json() : { collections: [] }))
      .then((d) => {
        if (cancelled) return
        const items: CollectionItem[] = (Array.isArray(d.collections) ? d.collections : [])
          .map(
            (c: {
              contractAddress?: string
              name?: string
              metadata?: { name?: string; image?: string; description?: string; kismet_thumbhash?: string }
            }) => {
              if (!c.contractAddress) return null
              return {
                address: c.contractAddress,
                name: c.metadata?.name ?? c.name ?? shortAddress(c.contractAddress),
                image: c.metadata?.image,
                description: c.metadata?.description,
                kismet_thumbhash: c.metadata?.kismet_thumbhash,
              }
            },
          )
          .filter((c: CollectionItem | null): c is CollectionItem => c !== null)
        setCollections(items)
      })
      .catch(() => {
        if (!cancelled) setCollections([])
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingCollections(false)
          setFetched(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [address])

  const { byAddress: perms, missingCount, loading: permsLoading, refetch: refetchPerms } =
    useCollectionsPermissions(collections.map((c) => c.address))

  // Recheck cooldown — wagmi's isLoading flag covers in-flight reads,
  // but it doesn't flip to true synchronously on click; rapid burst
  // taps within the same tick can still fire multiple multicalls
  // before isLoading reflects the first one. A 1.5s local cooldown
  // catches that window. The button is disabled when EITHER
  // permsLoading (genuine in-flight) OR cooldown (just-clicked).
  const [recheckCooldown, setRecheckCooldown] = useState(false)
  function handleRecheck() {
    if (recheckCooldown || permsLoading) return
    setRecheckCooldown(true)
    refetchPerms()
    setTimeout(() => setRecheckCooldown(false), 1500)
  }

  if (!isConnected) {
    return (
      <div className="text-center flex flex-col gap-4 items-center py-16">
        <h1 className="text-ink font-mono text-lg">Permissions</h1>
        <p className="text-dim font-mono text-xs max-w-md">
          Connect your wallet to see the permission status of every collection you&apos;ve deployed.
        </p>
        <button
          onClick={() => openConnectModal?.()}
          className="text-xs font-mono tracking-wider uppercase px-4 py-2 btn-accent"
        >
          connect wallet
        </button>
      </div>
    )
  }

  const isLoading = loadingCollections || (collections.length > 0 && permsLoading)

  return (
    <div className="flex flex-col gap-6">
      {/* Back-to-profile link. The dashboard's main entry point is the
          conditional banner on /profile/<own>, so users land here from
          there. Without an explicit nav, the only way back is the
          browser back button — works but feels orphaned. The link
          targets the connected user's own profile (the only profile
          where the banner could have surfaced). Hidden when the user
          isn't connected since there's no profile to link to. */}
      {address && (
        <Link
          href={`/profile/${address}`}
          className="text-[10px] font-mono text-muted hover:text-dim transition-colors flex items-center gap-1.5 w-fit uppercase tracking-wider"
        >
          <ArrowLeft size={11} />
          back to profile
        </Link>
      )}

      <div>
        <h1 className="text-ink font-mono text-lg mb-2">Permissions</h1>
        <p className="text-dim font-mono text-xs leading-relaxed">
          Each collection you&apos;ve deployed needs Kismet&apos;s smart wallet to hold ADMIN before it can mint via the inprocess relay. New deploys handle this automatically; legacy collections from before the upgrade may need a one-time onchain grant.
        </p>
      </div>

      {/* Smart-wallet readiness — surfaces a clear "we couldn't resolve
          your inprocess account" state when the upstream lookup fails.
          Without this, the rows would all show ⏳ forever and the user
          wouldn't know why. */}
      {!smartWalletLoading && !smartWallet && (
        <div className="border border-line bg-[#161616] p-4">
          <p className="text-xs font-mono text-ink mb-1">
            Could not resolve your inprocess smart wallet
          </p>
          <p className="text-[11px] font-mono text-dim">
            Sign in to inprocess.world at least once with this address ({address ? shortAddress(address) : ''}) so it can issue your smart wallet, then reload this page.
          </p>
        </div>
      )}

      {smartWallet && (
        <div className="text-[10px] font-mono text-muted flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="flex-shrink-0">your inprocess smart wallet:</span>
            <code className="text-dim truncate">{shortAddress(smartWallet)}</code>
          </div>
          {/* Global recheck — re-runs the batched permissions read so
              rows that errored ("unknown" state) get another shot
              after a transient RPC blip without forcing a full page
              reload. Also useful right after the user authorized a
              collection on /collection/<addr>: come back here, click
              recheck, see the row flip from ⚠️ to ✅. */}
          {collections.length > 0 && (
            <button
              type="button"
              onClick={handleRecheck}
              disabled={permsLoading || recheckCooldown}
              className="flex-shrink-0 px-2 py-1 border border-line text-dim hover:border-muted hover:text-ink disabled:opacity-50 disabled:cursor-not-allowed transition-colors uppercase tracking-wider"
              title="Re-read permissions on chain"
            >
              {permsLoading ? 'rechecking…' : 'recheck'}
            </button>
          )}
        </div>
      )}

      {fetched && !loadingCollections && collections.length === 0 ? (
        <div className="border border-line bg-[#161616] p-6 text-center">
          <p className="text-xs font-mono text-dim">
            You haven&apos;t deployed any collections yet.
          </p>
          <Link
            href="/mint"
            className="mt-3 inline-block text-xs font-mono tracking-wider uppercase px-4 py-2 btn-accent"
          >
            create your first collection
          </Link>
        </div>
      ) : (
        <>
          {missingCount > 0 && (
            <div className="border border-accent/40 bg-accent/5 p-3 sm:p-4 flex items-start gap-2.5">
              <ShieldAlert size={14} className="text-accent flex-shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-mono text-ink">
                  {missingCount === 1
                    ? '1 collection needs authorize'
                    : `${missingCount} collections need authorize`}
                </p>
                <p className="text-[11px] font-mono text-dim mt-1">
                  Click any row marked ⚠️ below to grant Kismet ADMIN with a single onchain transaction.
                </p>
              </div>
            </div>
          )}

          <ul className="flex flex-col gap-2">
            {collections.map((c) => {
              const status = perms[c.address.toLowerCase()]
              const hasAdmin = status?.hasAdmin
              return (
                <li key={c.address}>
                  <PermissionRow
                    address={c.address}
                    name={c.name}
                    img={c.image}
                    thumbhash={c.kismet_thumbhash}
                    description={c.description}
                    hasAdmin={hasAdmin}
                    loading={isLoading && status === undefined}
                  />
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}

// One row in the dashboard. Rendering split out so the conditional-
// status badge logic stays self-contained — the parent just maps
// over collections and lets the row decide which of the three states
// to render. Authorized rows are passive informational tiles; missing-
// admin rows highlight in amber and link to the collection page where
// the existing CollectionView Authorize banner runs the addPermission
// tx from the user's EOA.
function PermissionRow({
  address,
  name,
  img,
  thumbhash,
  description,
  hasAdmin,
  loading,
}: {
  address: string
  name: string
  img?: string
  thumbhash?: string
  description?: string
  hasAdmin: boolean | null | undefined
  loading: boolean
}) {
  const status: 'ok' | 'needs-auth' | 'unknown' =
    hasAdmin === true ? 'ok' : hasAdmin === false ? 'needs-auth' : 'unknown'

  const containerClass =
    status === 'needs-auth'
      ? 'border-accent/40 bg-accent/5 hover:bg-accent/10'
      : 'border-line bg-[#161616] hover:bg-raised'

  const RowInner = (
    <div className={`flex items-center gap-3 p-3 border ${containerClass} transition-colors`}>
      {img ? (
        <div className="w-12 h-12 relative flex-shrink-0 bg-raised overflow-hidden">
          <MomentImage src={img} alt={name} fill className="object-cover" sizes="48px" thumbhash={thumbhash} />
        </div>
      ) : (
        <div className="w-12 h-12 bg-raised flex-shrink-0 flex items-center justify-center">
          <span className="text-faint font-mono text-[9px]">{shortAddress(address)}</span>
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-mono text-ink truncate">{name}</p>
        {description && (
          <p className="text-[11px] font-mono text-muted mt-0.5 line-clamp-1">
            {description}
          </p>
        )}
        <p className="text-[10px] font-mono text-[#444] mt-0.5">
          {shortAddress(address)}
        </p>
      </div>
      <StatusBadge status={status} loading={loading} />
    </div>
  )

  // Whole tile is the click target — large hit area, links to the
  // collection page where the Authorize banner lives.
  return (
    <Link
      href={`/collection/${address}`}
      className="block focus:outline-none focus:ring-2 focus:ring-accent"
    >
      {RowInner}
    </Link>
  )
}

function StatusBadge({
  status,
  loading,
}: {
  status: 'ok' | 'needs-auth' | 'unknown'
  loading: boolean
}) {
  if (loading || status === 'unknown') {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 border border-line flex-shrink-0">
        <ShieldQuestion size={11} className="text-muted" />
        <span className="text-[10px] font-mono text-muted uppercase tracking-wider">
          {loading ? 'checking' : 'unknown'}
        </span>
      </div>
    )
  }
  if (status === 'ok') {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 border border-accent/40 bg-accent/5 flex-shrink-0">
        <ShieldCheck size={11} className="text-accent" />
        <span className="text-[10px] font-mono accent-grad uppercase tracking-wider">ready</span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 border border-accent/60 bg-accent/10 flex-shrink-0">
      <ShieldAlert size={11} className="text-accent" />
      <span className="text-[10px] font-mono text-ink uppercase tracking-wider">
        authorize
      </span>
    </div>
  )
}
