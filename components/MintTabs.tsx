'use client'

import { useState } from 'react'
import { MintForm } from '@/components/MintForm'
import { CreateCollectionForm } from '@/components/CreateCollectionForm'
import { AirdropForm } from '@/components/AirdropForm'

type Tab = 'mint' | 'create' | 'airdrop'

export function MintTabs() {
  const [tab, setTab] = useState<Tab>('mint')
  const [deployedCollection, setDeployedCollection] = useState<{ address: string; name: string } | null>(null)

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
            onClick={() => setTab(t.id)}
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
        <>
          {deployedCollection && (
            <div className="mb-6 p-3 border border-[#8B5CF6]/30 bg-[#8B5CF6]/5 flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-mono accent-grad">minting into: {deployedCollection.name}</p>
                <p className="text-xs font-mono text-[#555] mt-0.5 break-all">{deployedCollection.address}</p>
              </div>
              <button
                onClick={() => setDeployedCollection(null)}
                className="text-xs font-mono text-[#555] hover:text-[#888] whitespace-nowrap underline"
              >
                clear
              </button>
            </div>
          )}
          <MintForm collectionAddress={deployedCollection?.address} />
        </>
      )}

      {tab === 'create' && (
        <CreateCollectionForm onDeployed={handleDeployed} />
      )}

      {tab === 'airdrop' && (
        <AirdropForm collectionAddress={deployedCollection?.address ?? ''} />
      )}
    </div>
  )
}

