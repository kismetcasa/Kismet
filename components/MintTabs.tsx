'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAccount } from 'wagmi'
import { MintForm } from '@/components/MintForm'
import { CreateCollectionForm } from '@/components/CreateCollectionForm'
import { AirdropForm } from '@/components/AirdropForm'
import type { Moment } from '@/lib/inprocess'

type Tab = 'mint' | 'create' | 'airdrop'

interface MintTabsProps {
  initialCollection?: string
  initialCollectionName?: string
  /** Optional initial tab — used by CollectionView's authorization
   *  chips to land on the surface the granted bit unlocks (creator-
   *  tier → 'mint', minter-tier → 'airdrop'). Falls back to 'mint'. */
  initialTab?: string
}

function isValidTab(t: string | undefined): t is Tab {
  return t === 'mint' || t === 'create' || t === 'airdrop'
}

export function MintTabs({ initialCollection, initialCollectionName, initialTab }: MintTabsProps = {}) {
  const { address } = useAccount()
  const [tab, setTab] = useState<Tab>(isValidTab(initialTab) ? initialTab : 'mint')
  const [deployedCollection, setDeployedCollection] = useState<{ address: string; name: string } | null>(
    initialCollection ? { address: initialCollection, name: initialCollectionName || initialCollection } : null
  )
  const [moments, setMoments] = useState<Moment[]>([])
  const [loadingMoments, setLoadingMoments] = useState(false)
  // Last successful fetch timestamp (ms). Coalesces hover+click within
  // a 5s window but lets a tab re-open after an external hide/unhide
  // pick up fresh data.
  const [momentsFetchedAt, setMomentsFetchedAt] = useState<number>(0)

  // Reset when wallet changes
  useEffect(() => {
    setMoments([])
    setMomentsFetchedAt(0)
  }, [address])

  const fetchMoments = useCallback((opts: { force?: boolean } = {}) => {
    if (!address || loadingMoments) return
    // 5s coalescing window: hover+click won't double-fire, but a fresh
    // tab open after an external change refetches.
    if (!opts.force && momentsFetchedAt > 0 && Date.now() - momentsFetchedAt < 5_000) {
      return
    }
    setLoadingMoments(true)
    // Source: inprocess's /timeline?airdroppable filter (own moments +
    // per-token ADMIN delegations). Collection-wide MINTER / ADMIN
    // grants aren't surfaced here — discovery via on-chain log scan
    // would require unbounded eth_getLogs which most non-paid RPCs
    // cap out on. Authorized users airdrop by typing the moment URL
    // or via per-moment "Delegate airdrop" in this same form.
    fetch(`/api/timeline?airdroppable=${address}&limit=100`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        const moments = Array.isArray(d.moments) ? (d.moments as Moment[]) : []
        setMoments(moments)
      })
      .catch(() => setMoments([]))
      .finally(() => {
        setLoadingMoments(false)
        setMomentsFetchedAt(Date.now())
      })
  }, [address, loadingMoments, momentsFetchedAt])

  // Force-refetch when a moment is hidden or unhidden anywhere on the
  // site so the picker stops showing stale rows. MomentDetailView's
  // hide/unhide handler dispatches this event after the toggle lands.
  useEffect(() => {
    const onChange = () => fetchMoments({ force: true })
    window.addEventListener('kismetart:moment-hidden-changed', onChange)
    return () => window.removeEventListener('kismetart:moment-hidden-changed', onChange)
  }, [fetchMoments])

  // Eager-load the picker when we land on the airdrop tab via an
  // external CTA (e.g. CollectionView's authorization chip), so the
  // user doesn't see a blank picker until they hover the tab.
  useEffect(() => {
    if (tab === 'airdrop') fetchMoments()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  function handleDeployed(address: string, name: string) {
    setDeployedCollection({ address, name })
    setTab('mint')
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'mint', label: 'Mint' },
    { id: 'create', label: 'Create Collection' },
    { id: 'airdrop', label: 'Airdrop' },
  ]

  return (
    <div>
      <div className="flex gap-1 mb-8 border-b border-line pb-px">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => { if (t.id === 'airdrop') fetchMoments(); setTab(t.id) }}
            onMouseEnter={() => { if (t.id === 'airdrop') fetchMoments() }}
            className={`px-4 py-2 text-xs font-mono tracking-wider uppercase transition-colors border-b-2 -mb-px ${
              tab === t.id
                ? 'border-ink text-ink'
                : 'border-transparent text-dim hover:text-ink'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'mint' && (
        <MintForm
          collectionAddress={deployedCollection?.address}
          collectionName={deployedCollection?.name}
          onSwitchToCreate={() => {
            setTab('create')
            // Bring the user to the top of the Create Collection form;
            // without this they land halfway down the page (where they
            // were scrolled in the mint form) and the form they just
            // asked to see isn't actually in the viewport.
            if (typeof window !== 'undefined') {
              window.scrollTo({ top: 0, behavior: 'smooth' })
            }
          }}
        />
      )}

      {tab === 'create' && (
        <CreateCollectionForm onDeployed={handleDeployed} />
      )}

      {tab === 'airdrop' && (
        <AirdropForm moments={moments} loadingMoments={loadingMoments} />
      )}
    </div>
  )
}

