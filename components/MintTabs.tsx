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
}

export function MintTabs({ initialCollection, initialCollectionName }: MintTabsProps = {}) {
  const { address } = useAccount()
  const [tab, setTab] = useState<Tab>('mint')
  const [deployedCollection, setDeployedCollection] = useState<{ address: string; name: string } | null>(
    initialCollection ? { address: initialCollection, name: initialCollectionName || initialCollection } : null
  )
  const [moments, setMoments] = useState<Moment[]>([])
  const [loadingMoments, setLoadingMoments] = useState(false)
  // Last successful fetch timestamp, in ms. Used as a coalescing TTL so
  // hover + click within the same opening don't double-fire, but a tab
  // re-open after a hide/unhide tx outside the form picks up fresh data.
  // Previously this was a one-shot `momentsFetched` boolean that latched
  // forever — caused stale rows in the picker after the user hid a
  // moment elsewhere on the site.
  const [momentsFetchedAt, setMomentsFetchedAt] = useState<number>(0)

  // Reset when wallet changes
  useEffect(() => {
    setMoments([])
    setMomentsFetchedAt(0)
  }, [address])

  const fetchMoments = useCallback((opts: { force?: boolean } = {}) => {
    if (!address || loadingMoments) return
    // Coalesce repeated hover/click within a 5s window to one fetch.
    // Beyond that, refetch — the previous "fetch once per session" model
    // left the picker showing moments that had been hidden, deleted, or
    // newly delegated since the user first opened the tab. The 30s
    // server-side revalidate on the upstream inprocess call keeps the
    // refetch cheap when nothing actually changed.
    if (!opts.force && momentsFetchedAt > 0 && Date.now() - momentsFetchedAt < 5_000) {
      return
    }
    setLoadingMoments(true)
    // ?airdroppable=… surfaces both moments this user created AND moments
    // where they hold per-token ADMIN via a creator's "Delegate airdrop"
    // grant. Both groups can airdrop client-side via Zora's adminMint;
    // delegates without this filter would have no way to discover the
    // moments they're authorized for.
    fetch(`/api/timeline?airdroppable=${address}&limit=100`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setMoments(Array.isArray(d.moments) ? d.moments : []))
      .catch(() => setMoments([]))
      .finally(() => { setLoadingMoments(false); setMomentsFetchedAt(Date.now()) })
  }, [address, loadingMoments, momentsFetchedAt])

  // Force-refetch when a moment is hidden or unhidden anywhere on the
  // site so the picker stops showing stale rows. MomentDetailView's
  // hide/unhide handler dispatches this event after the toggle lands.
  useEffect(() => {
    const onChange = () => fetchMoments({ force: true })
    window.addEventListener('kismetart:moment-hidden-changed', onChange)
    return () => window.removeEventListener('kismetart:moment-hidden-changed', onChange)
  }, [fetchMoments])

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
      <div className="flex gap-1 mb-8 border-b border-[#2a2a2a] pb-px">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => { if (t.id === 'airdrop') fetchMoments(); setTab(t.id) }}
            onMouseEnter={() => { if (t.id === 'airdrop') fetchMoments() }}
            className={`px-4 py-2 text-xs font-mono tracking-wider uppercase transition-colors border-b-2 -mb-px ${
              tab === t.id
                ? 'border-[#efefef] text-[#efefef]'
                : 'border-transparent text-[#888] hover:text-[#efefef]'
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

