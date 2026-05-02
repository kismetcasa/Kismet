'use client'

import { useState, useEffect } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { resolveUri, shortAddress, type Moment, type MomentAdmin } from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { MomentCard } from './MomentCard'
import { ProfileAvatar } from './ProfileAvatar'

interface CollectionViewProps {
  address: string
  moments: Moment[]
  collectionName?: string
  collectionImage?: string
  collectionDescription?: string
  admins?: MomentAdmin[]
}

interface AvatarProfile {
  name: string
  avatarUrl?: string
}

export function CollectionView({
  address,
  moments,
  collectionName,
  collectionImage,
  collectionDescription,
  admins = [],
}: CollectionViewProps) {
  const router = useRouter()
  const [profiles, setProfiles] = useState<Record<string, AvatarProfile>>({})

  const firstMoment = moments[0]
  const displayName = collectionName || shortAddress(address)
  const rawImgUrl = collectionImage || firstMoment?.metadata?.image
  const imgUrl = rawImgUrl ? resolveUri(rawImgUrl) : null
  const description = collectionDescription

  // Unique creator addresses across all moments
  const uniqueCreators = Array.from(
    new Set(moments.map((m) => m.creator.address.toLowerCase()))
  )

  // Unique admin addresses not already in creators
  const uniqueAdmins = admins.filter(
    (a) => !uniqueCreators.includes(a.address.toLowerCase())
  )

  const allAddresses = [...uniqueCreators, ...uniqueAdmins.map((a) => a.address)]

  useEffect(() => {
    allAddresses.forEach((addr) => {
      fetchCreatorProfile(addr).then(({ name, avatarUrl }) => {
        setProfiles((prev: Record<string, AvatarProfile>) => ({ ...prev, [addr.toLowerCase()]: { name, avatarUrl } }))
      })
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address])

  function AvatarRow({ addr, label }: { addr: string; label?: string }) {
    const p = profiles[addr.toLowerCase()]
    return (
      <Link
        href={`/profile/${addr}`}
        className="flex items-center gap-2.5 border border-[#2a2a2a] hover:border-[#555] px-3 py-2 transition-colors"
      >
        <ProfileAvatar address={addr} avatarUrl={p?.avatarUrl} size={24} />
        <div className="flex flex-col min-w-0">
          <span className="text-xs font-mono text-[#888] truncate">
            {p?.name || shortAddress(addr)}
          </span>
          {label && (
            <span className="text-[10px] font-mono text-[#444]">{label}</span>
          )}
        </div>
      </Link>
    )
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <button
        onClick={() => router.back()}
        className="flex items-center gap-1.5 text-xs font-mono text-[#555] hover:text-[#888] transition-colors mb-8"
      >
        <ArrowLeft size={12} />
        back
      </button>

      {/* Collection header */}
      <div className="flex gap-5 mb-10">
        <div className="relative w-24 h-24 sm:w-32 sm:h-32 flex-shrink-0 bg-[#111] border border-[#2a2a2a] overflow-hidden">
          {imgUrl ? (
            <Image
              src={imgUrl}
              alt={displayName}
              fill
              className="object-cover"
              sizes="128px"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <span className="text-[#2a2a2a] font-mono text-[10px]">no image</span>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1.5 min-w-0 pt-1">
          <h1 className="text-base font-mono text-[#efefef] truncate">{displayName}</h1>
          <p className="text-[10px] font-mono text-[#444]">{shortAddress(address)}</p>
          {description && (
            <p className="text-xs font-mono text-[#555] mt-1 line-clamp-3">{description}</p>
          )}
        </div>
      </div>

      {/* Artists */}
      {uniqueCreators.length > 0 && (
        <section className="mb-10">
          <h2 className="text-xs font-mono text-[#555] uppercase tracking-widest mb-4">
            {uniqueCreators.length === 1 ? 'artist' : 'artists'}
          </h2>
          <div className="flex flex-wrap gap-2">
            {uniqueCreators.map((addr) => (
              <AvatarRow key={addr} addr={addr} />
            ))}
          </div>
        </section>
      )}

      {/* Splits */}
      {uniqueAdmins.length > 0 && (
        <section className="mb-10">
          <h2 className="text-xs font-mono text-[#555] uppercase tracking-widest mb-4">splits</h2>
          <div className="flex flex-wrap gap-2">
            {uniqueAdmins.map((admin) => (
              <AvatarRow key={admin.address} addr={admin.address} />
            ))}
          </div>
        </section>
      )}

      {/* NFT grid */}
      <section>
        <h2 className="text-xs font-mono text-[#555] uppercase tracking-widest mb-4">
          moments{moments.length > 0 ? ` (${moments.length})` : ''}
        </h2>
        {moments.length === 0 ? (
          <p className="text-xs font-mono text-[#555]">no moments in this collection yet</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {moments.map((m) => (
              <MomentCard key={m.id || `${m.address}-${m.token_id}`} moment={m} hidePriceSupply />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
