'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { ShieldCheck, ShieldAlert, ShieldQuestion } from 'lucide-react'
import { resolveUri, shortAddress } from '@/lib/inprocess'
import { useCollectionsPermissions } from '@/hooks/useCollectionsPermissions'
import { useInprocessSmartWallet } from '@/hooks/useInprocessSmartWallet'

interface CollectionItem {
  address: string
  name: string
  image?: string
  description?: string
}

/**
 * Phase 3 — central dashboard for an artist's collection permissions.
 *
 * Lists every collection the connected wallet has deployed (via
 * /api/collections?artist=…, which is creator-aware and includes hidden
 * ones for the owner). For each row, batch-reads permissions(0,
 * smartWallet) and renders a status badge:
 *
 *   ✅ green  — smart wallet has ADMIN; collection is mint-ready
 *   ⚠️ amber  — smart wallet missing ADMIN; needs a one-time Authorize
 *               from the creator (links to /collection/<addr> banner)
 *   ⏳ gray   — read still in flight or unknown (RPC blip etc.)
 *
 * Closes the discoverability gap from earlier phases: Phase 1's banner
 * only fires on a per-collection visit, Phase 2's picker badges only
 * surface during a mint flow. This page is the one-stop "is anything
 * broken?" view a user can bookmark or revisit after deploying many
 * collections.
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
              metadata?: { name?: string; image?: string; description?: string }
            }) => {
              if (!c.contractAddress) return null
              return {
                address: c.contractAddress,
                name: c.metadata?.name ?? c.name ?? shortAddress(c.contractAddress),
                image: c.metadata?.image,
                description: c.metadata?.description,
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

  const { byAddress: perms, missingCount, loading: permsLoading } =
    useCollectionsPermissions(collections.map((c) => c.address))

  if (!isConnected) {
    return (
      <div className="text-center flex flex-col gap-4 items-center py-16">
        <h1 className="text-[#efefef] font-mono text-lg">Permissions</h1>
        <p className="text-[#888] font-mono text-xs max-w-md">
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
      <div>
        <h1 className="text-[#efefef] font-mono text-lg mb-2">Permissions</h1>
        <p className="text-[#888] font-mono text-xs leading-relaxed">
          Each collection you&apos;ve deployed needs Kismet&apos;s smart wallet to hold ADMIN before it can mint via the inprocess relay. New deploys handle this automatically; legacy collections from before the upgrade may need a one-time onchain grant.
        </p>
      </div>

      {/* Smart-wallet readiness — surfaces a clear "we couldn't resolve
          your inprocess account" state when the upstream lookup fails.
          Without this, the rows would all show ⏳ forever and the user
          wouldn't know why. */}
      {!smartWalletLoading && !smartWallet && (
        <div className="border border-[#2a2a2a] bg-[#161616] p-4">
          <p className="text-xs font-mono text-[#efefef] mb-1">
            Could not resolve your inprocess smart wallet
          </p>
          <p className="text-[11px] font-mono text-[#888]">
            Sign in to inprocess.world at least once with this address ({shortAddress(address!)}) so it can issue your smart wallet, then reload this page.
          </p>
        </div>
      )}

      {smartWallet && (
        <div className="text-[10px] font-mono text-[#555] flex items-center gap-2">
          <span>kismet operator wallet:</span>
          <code className="text-[#888]">{shortAddress(smartWallet)}</code>
        </div>
      )}

      {fetched && !loadingCollections && collections.length === 0 ? (
        <div className="border border-[#2a2a2a] bg-[#161616] p-6 text-center">
          <p className="text-xs font-mono text-[#888]">
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
            <div className="border border-amber-700/50 bg-amber-950/30 p-3 sm:p-4 flex items-start gap-2.5">
              <ShieldAlert size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-mono text-amber-200">
                  {missingCount === 1
                    ? '1 collection needs authorize'
                    : `${missingCount} collections need authorize`}
                </p>
                <p className="text-[11px] font-mono text-amber-200/70 mt-1">
                  Click any row marked ⚠️ below to grant Kismet ADMIN with a single onchain transaction.
                </p>
              </div>
            </div>
          )}

          <ul className="flex flex-col gap-2">
            {collections.map((c) => {
              const status = perms[c.address.toLowerCase()]
              const hasAdmin = status?.hasAdmin
              const img = c.image ? resolveUri(c.image) : null
              return (
                <li key={c.address}>
                  <PermissionRow
                    address={c.address}
                    name={c.name}
                    img={img}
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
  description,
  hasAdmin,
  loading,
}: {
  address: string
  name: string
  img: string | null
  description?: string
  hasAdmin: boolean | null | undefined
  loading: boolean
}) {
  const status: 'ok' | 'needs-auth' | 'unknown' =
    hasAdmin === true ? 'ok' : hasAdmin === false ? 'needs-auth' : 'unknown'

  const containerClass =
    status === 'needs-auth'
      ? 'border-amber-700/50 bg-amber-950/20 hover:bg-amber-950/30'
      : 'border-[#2a2a2a] bg-[#161616] hover:bg-[#1a1a1a]'

  const RowInner = (
    <div className={`flex items-center gap-3 p-3 border ${containerClass} transition-colors`}>
      {img ? (
        <div className="w-12 h-12 relative flex-shrink-0 bg-[#1a1a1a] overflow-hidden">
          <Image src={img} alt={name} fill className="object-cover" sizes="48px" />
        </div>
      ) : (
        <div className="w-12 h-12 bg-[#1a1a1a] flex-shrink-0 flex items-center justify-center">
          <span className="text-[#333] font-mono text-[9px]">{shortAddress(address)}</span>
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-mono text-[#efefef] truncate">{name}</p>
        {description && (
          <p className="text-[11px] font-mono text-[#555] mt-0.5 line-clamp-1">
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

  // The row links to the collection page when authorize is needed
  // (where the Phase 1 banner handles the on-chain grant), otherwise
  // links to the same page for general management. Wrapping the whole
  // tile keeps the click target large.
  return (
    <Link
      href={`/collection/${address}`}
      className="block focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]"
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
      <div className="flex items-center gap-1.5 px-2 py-1 border border-[#2a2a2a] flex-shrink-0">
        <ShieldQuestion size={11} className="text-[#555]" />
        <span className="text-[10px] font-mono text-[#555] uppercase tracking-wider">
          {loading ? 'checking' : 'unknown'}
        </span>
      </div>
    )
  }
  if (status === 'ok') {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 border border-[#8B5CF6]/40 bg-[#8B5CF6]/5 flex-shrink-0">
        <ShieldCheck size={11} className="text-[#8B5CF6]" />
        <span className="text-[10px] font-mono accent-grad uppercase tracking-wider">ready</span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 border border-amber-600 bg-amber-900/30 flex-shrink-0">
      <ShieldAlert size={11} className="text-amber-300" />
      <span className="text-[10px] font-mono text-amber-200 uppercase tracking-wider">
        authorize
      </span>
    </div>
  )
}
