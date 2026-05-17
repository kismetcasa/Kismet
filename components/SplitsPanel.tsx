'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { shortAddress } from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { ProfileAvatar } from './ProfileAvatar'
import type { SplitRecipient } from '@/lib/splits'

interface Props {
  recipients: SplitRecipient[]
  // Optional click handler — overlay surfaces pass a dismiss callback so
  // navigating to a recipient's profile closes the overlay cleanly.
  onNavigate?: () => void
}

export function SplitsPanel({ recipients, onNavigate }: Props) {
  const [profiles, setProfiles] = useState<
    Record<string, { name: string; avatarUrl?: string }>
  >({})

  useEffect(() => {
    if (recipients.length === 0) return
    let cancelled = false
    recipients.forEach((r) => {
      fetchCreatorProfile(r.address).then(({ name, avatarUrl }) => {
        if (cancelled) return
        setProfiles((prev) => ({
          ...prev,
          [r.address.toLowerCase()]: { name, avatarUrl },
        }))
      })
    })
    return () => { cancelled = true }
  }, [recipients])

  if (recipients.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[10px] font-mono text-faint uppercase tracking-wider">splits</p>
      <div className="flex flex-col gap-1">
        {recipients.map((r) => {
          const lower = r.address.toLowerCase()
          const profile = profiles[lower]
          const label = profile?.name || shortAddress(r.address)
          return (
            <Link
              key={lower}
              href={`/profile/${r.address}`}
              onClick={onNavigate}
              className="flex items-center gap-2 group"
            >
              <ProfileAvatar address={r.address} avatarUrl={profile?.avatarUrl} size={18} />
              <span className="text-xs font-mono text-muted group-hover:text-dim transition-colors flex-1 truncate">
                {label}
              </span>
              <span className="text-[10px] font-mono text-[#444] flex-shrink-0">
                {r.percentAllocation}%
              </span>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
