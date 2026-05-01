'use client'

import { useState, useEffect } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { Star, Copy, Check, ExternalLink } from 'lucide-react'
import { useAccount, useReadContract } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { resolveUri, formatPrice, shortAddress, type Moment, type MomentDetail } from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { useAdmin } from '@/contexts/AdminContext'
import { ERC1155_ABI } from '@/lib/seaport'
import { ListButton } from './ListButton'
import { MomentModal } from './MomentModal'
import { ProfileAvatar } from './ProfileAvatar'

interface MomentCardProps {
  moment: Moment
  hidePriceSupply?: boolean
}

export function MomentCard({ moment, hidePriceSupply }: MomentCardProps) {
  const [imgError, setImgError] = useState(false)
  const [price, setPrice] = useState<string | null>(null)
  const [maxSupply, setMaxSupply] = useState<number | null | undefined>(undefined)
  const [creatorName, setCreatorName] = useState(() => shortAddress(moment.creator.address))
  const [creatorAvatar, setCreatorAvatar] = useState<string | undefined>(undefined)
  const [modalOpen, setModalOpen] = useState(false)
  const [collecting, setCollecting] = useState(false)
  const [collected, setCollected] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  const { isAdmin, featuredKeys, toggleFeatured } = useAdmin()
  const { address: connectedAddress, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()

  useEffect(() => {
    fetchCreatorProfile(moment.creator.address).then(({ name, avatarUrl }) => {
      setCreatorName(name)
      setCreatorAvatar(avatarUrl)
    })
  }, [moment.creator.address])

  const { data: ownedBalance } = useReadContract({
    address: moment.address as `0x${string}`,
    abi: ERC1155_ABI,
    functionName: 'balanceOf',
    args: connectedAddress ? [connectedAddress, BigInt(moment.token_id)] : undefined,
    query: { enabled: !!connectedAddress },
  })
  const owned = ownedBalance ? Number(ownedBalance) : 0

  const meta = moment.metadata ?? {}
  const isFeatured = featuredKeys.has(`${moment.address.toLowerCase()}:${moment.token_id}`)

  // Fetch sale config for price + supply display
  useEffect(() => {
    if (hidePriceSupply) return
    const params = new URLSearchParams({
      collectionAddress: moment.address,
      tokenId: moment.token_id,
      chainId: '8453',
    })
    fetch(`/api/moment?${params}`)
      .then((r) => r.ok ? r.json() as Promise<MomentDetail> : Promise.reject())
      .then((detail) => {
        setPrice(formatPrice(detail.saleConfig.pricePerToken))
        setMaxSupply(detail.maxSupply ?? null)
      })
      .catch(() => {})
  }, [moment.address, moment.token_id, hidePriceSupply])

  function handleCopyLink() {
    navigator.clipboard.writeText(`${window.location.origin}/moment/${moment.address}/${moment.token_id}`).catch(() => {})
    setLinkCopied(true)
    setTimeout(() => setLinkCopied(false), 1500)
  }

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

  const imageUrl = meta.image ? resolveUri(meta.image) : null
  const isVideo =
    meta.content?.mime?.startsWith('video/') ||
    meta.animation_url?.endsWith('.mp4') ||
    meta.animation_url?.endsWith('.webm')
  const mediaUrl = isVideo && meta.animation_url ? resolveUri(meta.animation_url) : imageUrl
  return (
    <>
      <article className="group flex flex-col bg-[#161616] border border-[#2a2a2a] overflow-hidden">
        {/* Media — click opens modal */}
        <div
          onClick={() => setModalOpen(true)}
          className="cursor-pointer relative aspect-square bg-[#111] overflow-hidden"
        >
          {owned > 0 && (
            <span className="absolute top-2 left-2 z-10 px-1.5 py-0.5 bg-[#0d0d0d]/80 border border-[#2a2a2a] text-[#efefef] font-mono text-[10px] leading-tight">
              ×{owned}
            </span>
          )}
          {isAdmin && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                toggleFeatured(moment.address, moment.token_id)
              }}
              className={`absolute top-2 right-2 z-10 p-1 transition-colors ${
                isFeatured ? 'text-yellow-400' : 'text-[#333] hover:text-[#888]'
              }`}
              title={isFeatured ? 'Unfeature' : 'Feature'}
            >
              <Star size={16} fill={isFeatured ? 'currentColor' : 'none'} strokeWidth={1.5} />
            </button>
          )}
          {isVideo && mediaUrl ? (
            <video
              src={mediaUrl}
              className="w-full h-full object-cover"
              autoPlay
              muted
              loop
              playsInline
            />
          ) : imageUrl && !imgError ? (
            <Image
              src={imageUrl}
              alt={meta.name ?? 'moment'}
              fill
              className="object-cover transition-transform duration-500 group-hover:scale-105"
              onError={() => setImgError(true)}
              sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <span className="text-[#2a2a2a] font-mono text-xs">no preview</span>
            </div>
          )}
        </div>

        {/* Info */}
        <div className="px-4 pt-4 pb-3 flex flex-col gap-1.5">
          <div className="flex items-start gap-2">
            <h3 className="text-sm text-[#efefef] font-mono truncate flex-1 min-w-0">
              {meta.name ?? `#${moment.token_id}`}
            </h3>
            {/* Share + external link */}
            <div className="flex items-center gap-1.5 flex-shrink-0 mt-0.5">
              <button
                onClick={handleCopyLink}
                title="copy link"
                className="text-[#444] hover:text-[#888] transition-colors"
              >
                {linkCopied
                  ? <Check size={11} className="text-[#6ee7b7]" />
                  : <Copy size={11} />}
              </button>
              <Link
                href={`/moment/${moment.address}/${moment.token_id}`}
                title="view page"
                className="text-[#444] hover:text-[#888] transition-colors"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink size={11} />
              </Link>
            </div>
          </div>
          <Link
            href={`/profile/${moment.creator.address}`}
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1.5 group/creator w-fit"
            title={moment.creator.address}
          >
            <ProfileAvatar address={moment.creator.address} avatarUrl={creatorAvatar} size={16} />
            <span className="text-xs text-[#555] font-mono group-hover/creator:text-[#888] transition-colors">{creatorName}</span>
          </Link>
        </div>

        {/* Actions — list (if owned) + collect + price */}
        <div className="px-4 pb-4 flex flex-col gap-1.5 sm:flex-row sm:gap-2 sm:items-stretch">
          {owned > 0 && (
            <div className="w-full sm:w-1/3 sm:flex-none">
              <ListButton
                collectionAddress={moment.address}
                tokenId={moment.token_id}
                name={meta.name}
                image={meta.image ? resolveUri(meta.image) : undefined}
                creatorAddress={moment.creator?.address}
              />
            </div>
          )}
          <div className={`flex ${owned > 0 ? 'w-full sm:flex-1' : 'w-full'} border transition-colors ${
            collected ? 'border-[#8B5CF6]' : 'border-[#2a2a2a]'
          }`}>
            <button
              onClick={handleCollect}
              disabled={collecting || collected}
              className={`flex-1 py-2.5 text-xs font-mono tracking-wider uppercase transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                collected ? 'text-[#8B5CF6] bg-[#8B5CF6]/10' : 'text-[#555] hover:bg-gradient-to-r hover:from-[#8B5CF6] hover:to-[#C084FC] hover:text-white'
              }`}
            >
              {collecting ? 'collecting…' : collected ? 'collected' : 'collect'}
            </button>
            {!hidePriceSupply && (
              <>
                <div className="border-l border-[#2a2a2a] px-2 py-1.5 flex items-center justify-center min-w-[3rem]">
                  <span className="text-[11px] font-mono text-[#444]">
                    {maxSupply === undefined ? '…' : (maxSupply === null || maxSupply === 0 ? 'open' : maxSupply.toLocaleString())}
                  </span>
                </div>
                <div className="border-l border-[#2a2a2a] px-2 py-1.5 flex items-center justify-center min-w-[3rem]">
                  <span className="text-[11px] font-mono accent-grad">{price ?? '…'}</span>
                </div>
              </>
            )}
          </div>
        </div>
      </article>

      {modalOpen && (
        <MomentModal
          moment={moment}
          onClose={() => setModalOpen(false)}
          initialPrice={price ?? undefined}
          initialMaxSupply={maxSupply !== undefined ? maxSupply : undefined}
          initialCreatorName={creatorName}
          initialCreatorAvatar={creatorAvatar}
          initialOwnedBalance={ownedBalance !== undefined ? Number(ownedBalance) : undefined}
        />
      )}
    </>
  )
}
