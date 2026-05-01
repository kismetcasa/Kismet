'use client'

import { useState, useEffect } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { X } from 'lucide-react'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { resolveUri, formatPrice, shortAddress, type Moment, type MomentDetail } from '@/lib/inprocess'
import { ListButton } from './ListButton'

interface MomentModalProps {
  moment: Moment
  onClose: () => void
}

export function MomentModal({ moment, onClose }: MomentModalProps) {
  const [detail, setDetail] = useState<MomentDetail | null>(null)
  const [collecting, setCollecting] = useState(false)
  const [collected, setCollected] = useState(false)
  const { address: connectedAddress, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()

  const meta = moment.metadata ?? {}
  const imageUrl = meta.image ? resolveUri(meta.image) : null
  const isVideo =
    meta.content?.mime?.startsWith('video/') ||
    meta.animation_url?.endsWith('.mp4') ||
    meta.animation_url?.endsWith('.webm')
  const mediaUrl = isVideo && meta.animation_url ? resolveUri(meta.animation_url) : imageUrl
  const creatorAddress = moment.creator.address

  useEffect(() => {
    const params = new URLSearchParams({
      collectionAddress: moment.address,
      tokenId: moment.token_id,
      chainId: '8453',
    })
    fetch(`/api/moment?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setDetail(d))
      .catch(() => {})
  }, [moment.address, moment.token_id])

  // Lock body scroll while open
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  // Close on ESC
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  async function handleCollect() {
    if (!isConnected || !connectedAddress) { openConnectModal?.(); return }
    setCollecting(true)
    try {
      const res = await fetch('/api/collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          moment: { collectionAddress: moment.address, tokenId: moment.token_id, chainId: 8453 },
          amount: 1,
          comment: 'collected via Kismet Art',
          account: connectedAddress,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Collect failed')
      setCollected(true)
      toast.success('Collected!')
    } catch (err) {
      toast.error('Collect failed', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally {
      setCollecting(false)
    }
  }

  const price = detail ? formatPrice(detail.saleConfig.pricePerToken) : null
  const maxSupply = detail?.maxSupply
  const supplyLabel = !maxSupply ? 'open' : maxSupply.toLocaleString()

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="relative w-full max-w-3xl bg-[#161616] border border-[#2a2a2a] flex flex-col md:grid md:grid-cols-2 max-h-[90vh] overflow-hidden">
        <button
          onClick={onClose}
          className="absolute top-3 right-3 z-10 p-1 text-[#555] hover:text-[#888] transition-colors"
        >
          <X size={16} />
        </button>

        {/* Left: media */}
        <div className="relative aspect-square bg-[#111] flex-shrink-0 border-b border-[#2a2a2a] md:border-b-0 md:border-r md:border-r-[#2a2a2a]">
          {isVideo && mediaUrl ? (
            <video src={mediaUrl} className="w-full h-full object-cover" autoPlay muted loop playsInline />
          ) : imageUrl ? (
            <Image src={imageUrl} alt={meta.name ?? 'moment'} fill className="object-cover" sizes="(max-width: 768px) 100vw, 50vw" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <span className="text-[#2a2a2a] font-mono text-xs">no preview</span>
            </div>
          )}
        </div>

        {/* Right: info */}
        <div className="flex flex-col md:min-h-0 md:overflow-y-auto">
          <div className="px-5 py-4 flex flex-col gap-3 flex-1">
            <h2 className="text-sm font-mono text-[#efefef] leading-snug pr-6">
              {meta.name ?? `#${moment.token_id}`}
            </h2>
            <Link
              href={`/profile/${creatorAddress}`}
              onClick={onClose}
              className="text-xs font-mono text-[#555] hover:text-[#888] transition-colors w-fit"
            >
              by {moment.creator.username || shortAddress(creatorAddress)}
            </Link>
            {meta.description && (
              <p className="text-xs font-mono text-[#888] leading-relaxed line-clamp-4">
                {meta.description}
              </p>
            )}
          </div>

          <div className="flex-1 min-h-4" />

          <div className="px-5 pb-5 flex flex-col gap-2">
            <Link
              href={`/moment/${moment.address}/${moment.token_id}`}
              onClick={onClose}
              className="w-full text-center text-xs font-mono tracking-wider uppercase px-3 py-2.5 border border-[#2a2a2a] text-[#555] hover:border-[#555] hover:text-[#efefef] transition-colors"
            >
              view page →
            </Link>

            {/* List + Collect row */}
            <div className="flex">
              <div className="flex-1">
                <ListButton
                  collectionAddress={moment.address}
                  tokenId={moment.token_id}
                  name={meta.name}
                  image={meta.image ? resolveUri(meta.image) : undefined}
                  creatorAddress={creatorAddress}
                />
              </div>
              <div className={`flex flex-1 -ml-px border transition-colors ${collected ? 'border-[#8B5CF6]' : 'border-[#2a2a2a]'}`}>
                <button
                  onClick={handleCollect}
                  disabled={collecting || collected}
                  className={`flex-1 py-2.5 text-xs font-mono tracking-wider uppercase transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    collected ? 'text-[#8B5CF6] bg-[#8B5CF6]/10' : 'text-[#555] hover:text-[#8B5CF6]'
                  }`}
                >
                  {collecting ? 'collecting…' : collected ? 'collected' : 'collect'}
                </button>
                <div className="border-l border-[#2a2a2a] px-2 py-1.5 flex flex-col items-end justify-between min-w-[3.5rem]">
                  <span className="text-[9px] font-mono accent-grad">{price ?? '…'}</span>
                  <span className="text-[9px] font-mono text-[#444]">{supplyLabel}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
