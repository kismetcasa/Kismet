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
  const [momentsFetched, setMomentsFetched] = useState(false)

  // Reset when wallet changes
  useEffect(() => {
    setMoments([])
    setMomentsFetched(false)
  }, [address])

  const fetchMoments = useCallback(() => {
    if (!address || loadingMoments || momentsFetched) return
    setLoadingMoments(true)
    // ?airdroppable=… surfaces both moments this user created AND moments
    // where they hold per-token ADMIN via a creator's "Delegate airdrop"
    // grant. Without this, delegates would have no way to find their
    // delegated moments in the picker even though /api/airdrop would
    // authorize them to airdrop.
    fetch(`/api/timeline?airdroppable=${address}&limit=100`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setMoments(Array.isArray(d.moments) ? d.moments : []))
      .catch(() => setMoments([]))
      .finally(() => { setLoadingMoments(false); setMomentsFetched(true) })
  }, [address, loadingMoments, momentsFetched])

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

