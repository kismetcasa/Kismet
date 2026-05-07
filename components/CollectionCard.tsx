'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { resolveUri, shortAddress } from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'

/**
 * Shape we render — compatible with both inprocess `/api/collections` plural
 * (lightweight rows from `data.collections[]`) and `/api/collection` singular
 * (rich object with default_admin + timestamps). The optional fields fall
 * back gracefully when absent.
 */
export interface CollectionDisplay {
  contractAddress: string
  name?: string
  metadata?: { name?: string; image?: string; description?: string }
  // inprocess `/api/collection` (singular) extras — used when present
  default_admin?: { address?: string; username?: string }
  created_at?: string
}

interface CollectionCardProps {
  collection: CollectionDisplay
  // Override the right-hand action. Default = "mint into" (link to /mint
  // with this collection pre-selected). Featured rows pass a custom node
  // for bulk-collect or alternate CTAs.
  primaryAction?: React.ReactNode
}

export function CollectionCard({ collection, primaryAction }: CollectionCardProps) {
  const c = collection
  const imgUrl = c.metadata?.image ? resolveUri(c.metadata.image) : null
  const collectionName = c.metadata?.name || c.name || shortAddress(c.contractAddress)
  const description = c.metadata?.description

  // Resolve creator's display name from either the inline default_admin
  // (when /api/collection populated it) or our profile cache. Falls back
  // to shortAddress so the chip never disappears.
  const adminAddr = c.default_admin?.address
  const initialName = c.default_admin?.username
    ?? (adminAddr ? shortAddress(adminAddr) : null)
  const [creatorLabel, setCreatorLabel] = useState<string | null>(
    initialName ? (c.default_admin?.username ? `@${c.default_admin.username}` : initialName) : null,
  )
  useEffect(() => {
    if (!adminAddr || c.default_admin?.username) return
    fetchCreatorProfile(adminAddr).then(({ name }) => {
      // profileCache returns username if set, otherwise shortAddress. The
      // `@` prefix only makes sense when a real username resolved.
      const isUsername = name && name !== shortAddress(adminAddr)
      setCreatorLabel(isUsername ? `@${name}` : shortAddress(adminAddr))
    })
  }, [adminAddr, c.default_admin?.username])

  return (
    <article className="flex flex-col bg-[#161616] border border-[#2a2a2a] overflow-hidden">
      <Link
        href={`/collection/${c.contractAddress}`}
        className="relative aspect-square bg-[#111] block overflow-hidden group/img"
      >
        {imgUrl ? (
          <Image
            src={imgUrl}
            alt={collectionName}
            fill
            className="object-contain transition-transform duration-500 group-hover/img:scale-105"
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-[#2a2a2a] font-mono text-xs">no preview</span>
          </div>
        )}
      </Link>

      <div className="px-4 pt-4 pb-2 flex flex-col gap-1">
        <h3 className="text-sm text-[#efefef] font-mono truncate">{collectionName}</h3>
        {creatorLabel && (
          <Link
            href={adminAddr ? `/profile/${adminAddr}` : '#'}
            className="text-xs font-mono text-[#555] hover:text-[#888] transition-colors w-fit"
          >
            {creatorLabel}
          </Link>
        )}
        {description && (
          <p className="text-xs font-mono text-[#555] mt-0.5 line-clamp-2">{description}</p>
        )}
      </div>

      <div className="px-4 pb-4 flex flex-col gap-1.5 mt-auto">
        <Link
          href={`/collection/${c.contractAddress}`}
          className="w-full py-1.5 text-center text-xs font-mono border border-[#2a2a2a] text-[#888] hover:border-[#555] hover:text-[#efefef] transition-colors"
        >
          view
        </Link>
        {primaryAction ?? (
          <Link
            href={`/mint?collection=${c.contractAddress}&name=${encodeURIComponent(collectionName)}`}
            className="w-full py-1.5 text-center text-xs font-mono border border-[#8B5CF6]/40 text-[#8B5CF6] hover:border-[#8B5CF6] hover:bg-[#8B5CF6]/10 transition-colors"
          >
            mint into
          </Link>
        )}
      </div>
    </article>
  )
}
