'use client'

import { useState } from 'react'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { isAddress } from 'viem'
import { Plus, X } from 'lucide-react'
import Image from 'next/image'
import { resolveUri, shortAddress, type Moment } from '@/lib/inprocess'

interface AirdropFormProps {
  moments: Moment[]
  loadingMoments: boolean
}

export function AirdropForm({ moments, loadingMoments }: AirdropFormProps) {
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()

  const [selected, setSelected] = useState<Moment | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
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
    if (!selected) { toast.error('Select a moment to airdrop'); return }
    if (recipients.length === 0) { toast.error('Add at least one recipient'); return }

    setSending(true)
    setResultHash(null)
    try {
      const res = await fetch('/api/airdrop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collectionAddress: selected.address,
          recipients: recipients.map((r) => ({ recipientAddress: r, tokenId: selected.token_id })),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? data.detail ?? 'Airdrop failed')
      setResultHash(data.hash)
      setRecipients([])
      toast.success(`Airdropped to ${recipients.length} recipient${recipients.length !== 1 ? 's' : ''}`)
    } catch (err) {
      toast.error('Airdrop failed', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally {
      setSending(false)
    }
  }

  const selectedMeta = selected?.metadata ?? {}
  const selectedImage = selectedMeta.image ? resolveUri(selectedMeta.image) : null

  return (
    <form onSubmit={handleAirdrop} className="flex flex-col gap-6">

      {/* Moment picker */}
      <div>
        <label className="block text-xs font-mono text-[#888] uppercase tracking-wider mb-2">
          Moment <span className="text-[#efefef]">*</span>
        </label>

        {/* Selected moment preview / trigger */}
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          className="w-full flex items-center gap-3 bg-[#111] border border-[#2a2a2a] px-3 py-2.5 hover:border-[#555] transition-colors text-left"
        >
          {selected ? (
            <>
              {selectedImage ? (
                <div className="w-8 h-8 relative flex-shrink-0 bg-[#1a1a1a] overflow-hidden">
                  <Image src={selectedImage} alt="" fill className="object-cover" sizes="32px" />
                </div>
              ) : (
                <div className="w-8 h-8 bg-[#1a1a1a] flex-shrink-0" />
              )}
              <span className="text-sm text-[#efefef] font-mono truncate flex-1">
                {selectedMeta.name ?? `#${selected.token_id}`}
              </span>
            </>
          ) : (
            <span className="text-sm text-[#333] font-mono flex-1">
              {loadingMoments ? 'loading your moments…' : 'select a moment'}
            </span>
          )}
          <span className="text-[#555] text-xs font-mono flex-shrink-0">
            {pickerOpen ? '▲' : '▼'}
          </span>
        </button>

        {/* Picker grid */}
        {pickerOpen && (
          <div className="border border-t-0 border-[#2a2a2a] bg-[#0d0d0d] max-h-64 overflow-y-auto">
            {moments.length === 0 ? (
              <p className="text-xs font-mono text-[#555] px-3 py-4">
                {loadingMoments ? 'loading…' : 'no minted moments found'}
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-px bg-[#2a2a2a]">
                {moments.map((m, idx) => {
                  const meta = m.metadata ?? {}
                  const img = meta.image ? resolveUri(meta.image) : null
                  const isSelected = selected?.address === m.address && selected?.token_id === m.token_id
                  return (
                    <button
                      key={`${m.address}:${m.token_id}`}
                      type="button"
                      onClick={() => { setSelected(m); setPickerOpen(false) }}
                      className={`relative aspect-square bg-[#111] overflow-hidden group ${isSelected ? 'ring-2 ring-inset ring-[#8B5CF6]' : ''}`}
                    >
                      {img ? (
                        <Image src={img} alt={meta.name ?? ''} fill className="object-cover" sizes="120px" priority={idx < 6} />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <span className="text-[#333] font-mono text-[10px]">#{m.token_id}</span>
                        </div>
                      )}
                      <div className="absolute inset-x-0 bottom-0 bg-black/70 px-1.5 py-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                        <p className="text-[9px] font-mono text-[#efefef] truncate">{meta.name ?? `#${m.token_id}`}</p>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Recipients */}
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
            placeholder="0x… wallet address"
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
          <ul className="flex flex-col gap-1 mb-1.5">
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
          <p className="text-xs font-mono text-[#555]">
            {recipients.length} recipient{recipients.length !== 1 ? 's' : ''}
            {' — '}each receives 1 fresh copy (minted, not transferred)
          </p>
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
        disabled={sending || !selected || recipients.length === 0}
        className="w-full py-3 text-xs font-mono tracking-widest uppercase btn-accent disabled:opacity-50"
      >
        {!isConnected
          ? 'connect wallet to airdrop'
          : sending
          ? 'airdropping…'
          : selected && recipients.length > 0
          ? `airdrop to ${recipients.length} wallet${recipients.length !== 1 ? 's' : ''}`
          : 'airdrop'}
      </button>

      <p className="text-[10px] font-mono text-[#444] text-center -mt-2">
        airdrop freshly minted supply to recipients
      </p>

    </form>
  )
}
