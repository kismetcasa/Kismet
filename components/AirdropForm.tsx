'use client'

import { useState } from 'react'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { isAddress } from 'viem'
import { Plus, X } from 'lucide-react'
import { shortAddress } from '@/lib/inprocess'

interface AirdropFormProps {
  collectionAddress?: string
  tokenId?: string
}

export function AirdropForm({ collectionAddress: initialCollection = '', tokenId: initialTokenId = '' }: AirdropFormProps) {
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()

  const [collection, setCollection] = useState(initialCollection)
  const [tokenId, setTokenId] = useState(initialTokenId)
  const [recipientInput, setRecipientInput] = useState('')
  const [recipients, setRecipients] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  const [resultHash, setResultHash] = useState<string | null>(null)

  function addRecipient() {
    const addr = recipientInput.trim()
    if (!isAddress(addr)) { toast.error('Invalid address'); return }
    if (recipients.includes(addr.toLowerCase())) { toast.error('Already added'); return }
    setRecipients((prev) => [...prev, addr.toLowerCase()])
    setRecipientInput('')
  }

  function removeRecipient(addr: string) {
    setRecipients((prev) => prev.filter((r) => r !== addr))
  }

  async function handleAirdrop(e: React.FormEvent) {
    e.preventDefault()
    if (!isConnected || !address) { openConnectModal?.(); return }
    if (!isAddress(collection)) { toast.error('Invalid collection address'); return }
    if (!tokenId.trim() || !/^\d+$/.test(tokenId.trim())) { toast.error('Invalid token ID'); return }
    if (recipients.length === 0) { toast.error('Add at least one recipient'); return }

    setSending(true)
    try {
      const res = await fetch('/api/airdrop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collectionAddress: collection,
          recipients: recipients.map((r) => ({ recipientAddress: r, tokenId: tokenId.trim() })),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? data.detail ?? 'Airdrop failed')
      setResultHash(data.hash)
      setRecipients([])
      toast.success(`Airdropped to ${recipients.length} recipient${recipients.length > 1 ? 's' : ''}`)
    } catch (err) {
      toast.error('Airdrop failed', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally {
      setSending(false)
    }
  }

  return (
    <form onSubmit={handleAirdrop} className="flex flex-col gap-6">
      <div>
        <label className="block text-xs font-mono text-[#888] uppercase tracking-wider mb-2">
          Collection Address <span className="text-[#efefef]">*</span>
        </label>
        <input
          type="text"
          value={collection}
          onChange={(e) => setCollection(e.target.value)}
          placeholder="0x…"
          className="w-full bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555]"
        />
      </div>

      <div>
        <label className="block text-xs font-mono text-[#888] uppercase tracking-wider mb-2">
          Token ID <span className="text-[#efefef]">*</span>
        </label>
        <input
          type="text"
          inputMode="numeric"
          value={tokenId}
          onChange={(e) => { if (e.target.value === '' || /^\d+$/.test(e.target.value)) setTokenId(e.target.value) }}
          placeholder="1"
          className="w-full bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555]"
        />
      </div>

      <div>
        <label className="block text-xs font-mono text-[#888] uppercase tracking-wider mb-2">
          Recipients
        </label>
        <div className="flex gap-2 mb-2">
          <input
            type="text"
            value={recipientInput}
            onChange={(e) => setRecipientInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRecipient() } }}
            placeholder="0x… address"
            className="flex-1 bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555]"
          />
          <button
            type="button"
            onClick={addRecipient}
            className="px-3 border border-[#2a2a2a] text-[#888] hover:border-[#555] hover:text-[#efefef] transition-colors"
          >
            <Plus size={14} />
          </button>
        </div>
        {recipients.length > 0 && (
          <ul className="flex flex-col gap-1">
            {recipients.map((r) => (
              <li key={r} className="flex items-center justify-between bg-[#111] border border-[#2a2a2a] px-3 py-2">
                <span className="text-xs font-mono text-[#888]">{shortAddress(r)}</span>
                <button type="button" onClick={() => removeRecipient(r)} className="text-[#555] hover:text-[#888]">
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {recipients.length > 0 && (
          <p className="text-xs font-mono text-[#555] mt-1.5">{recipients.length} recipient{recipients.length > 1 ? 's' : ''}</p>
        )}
      </div>

      {resultHash && (
        <a
          href={`https://basescan.org/tx/${resultHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-mono text-[#555] hover:text-[#888] transition-colors"
        >
          tx: {resultHash.slice(0, 10)}…{resultHash.slice(-8)}
        </a>
      )}

      <button
        type="submit"
        disabled={sending}
        className="w-full py-3 text-xs font-mono tracking-widest uppercase btn-accent disabled:opacity-50"
      >
        {!isConnected ? 'connect wallet to airdrop' : sending ? 'airdropping…' : 'airdrop'}
      </button>
    </form>
  )
}
