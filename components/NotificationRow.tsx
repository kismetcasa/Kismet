'use client'

import Link from 'next/link'
import { Sparkles, Clock } from 'lucide-react'
import { ProfileAvatar } from './ProfileAvatar'
import { shortAddress, formatRelativeTime, formatPrice, resolveUri } from '@/lib/inprocess'
import type { Notification } from '@/lib/notifications'

interface NotificationRowProps {
  notification: Notification
  onClick?: () => void
  onMute?: (actor: string) => void
  compact?: boolean
}

function notificationHref(n: Notification): string {
  switch (n.type) {
    case 'follow':
      return n.actor ? `/profile/${n.actor}` : '/'
    case 'collect':
    case 'sale':
    case 'mint':
    case 'listing_expired':
      return n.tokenAddress && n.tokenId ? `/moment/${n.tokenAddress}/${n.tokenId}` : '/'
  }
}

function NotificationContent({ n }: { n: Notification }) {
  const time = formatRelativeTime(n.timestamp)

  switch (n.type) {
    case 'collect':
      return (
        <>
          <p className="text-xs font-mono text-[#efefef] truncate">
            {n.actor ? shortAddress(n.actor) : 'someone'} collected {n.tokenName ? `"${n.tokenName}"` : 'your moment'}
          </p>
          {n.comment && (
            <p className="text-[10px] font-mono text-[#888] mt-0.5 truncate">"{n.comment}"</p>
          )}
          <p className="text-[10px] font-mono text-[#555] mt-0.5 truncate">
            {n.amount && n.amount > 1 ? `${n.amount} editions` : '1 edition'}
            {n.price ? ` · ${formatPrice(n.price)}` : ''} · {time}
          </p>
        </>
      )
    case 'sale':
      return (
        <>
          <p className="text-xs font-mono text-[#efefef] truncate">
            {n.actor ? `${shortAddress(n.actor)} bought your listing` : 'your listing was filled'}
          </p>
          <p className="text-[10px] font-mono text-[#555] mt-0.5 truncate">
            {n.tokenName ?? 'untitled'}{n.price ? ` · ${formatPrice(n.price)}` : ''} · {time}
          </p>
        </>
      )
    case 'follow':
      return (
        <>
          <p className="text-xs font-mono text-[#efefef] truncate">
            {n.actor ? shortAddress(n.actor) : 'someone'} followed you
          </p>
          <p className="text-[10px] font-mono text-[#555] mt-0.5 truncate">{time}</p>
        </>
      )
    case 'mint':
      return (
        <>
          <p className="text-xs font-mono text-[#efefef] truncate">your moment was created</p>
          <p className="text-[10px] font-mono text-[#555] mt-0.5 truncate">
            {n.tokenName ?? 'untitled'} · {time}
          </p>
        </>
      )
    case 'listing_expired':
      return (
        <>
          <p className="text-xs font-mono text-[#efefef] truncate">your listing expired</p>
          <p className="text-[10px] font-mono text-[#555] mt-0.5 truncate">
            {n.tokenName ?? 'untitled'}{n.price ? ` · ${formatPrice(n.price)}` : ''} · {time}
          </p>
        </>
      )
  }
}

function NotificationLeft({ n, size }: { n: Notification; size: number }) {
  const iconSize = Math.round(size * 0.45)

  if (n.type === 'mint') {
    return (
      <div
        style={{ width: size, height: size }}
        className="bg-[#1a1a1a] flex-shrink-0 flex items-center justify-center"
      >
        <Sparkles size={iconSize} className="text-[#8B5CF6]" />
      </div>
    )
  }

  if (n.type === 'listing_expired') {
    if (n.tokenImage) {
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={resolveUri(n.tokenImage)} alt="" className="object-cover flex-shrink-0" style={{ width: size, height: size }} />
    }
    return (
      <div
        style={{ width: size, height: size }}
        className="bg-[#1a1a1a] flex-shrink-0 flex items-center justify-center"
      >
        <Clock size={iconSize} className="text-[#555]" />
      </div>
    )
  }

  if (n.type === 'follow' || !n.tokenImage) {
    if (n.actor) return <ProfileAvatar address={n.actor} size={size} />
    return <div style={{ width: size, height: size }} className="bg-[#1a1a1a] flex-shrink-0" />
  }

  // eslint-disable-next-line @next/next/no-img-element
  return <img src={resolveUri(n.tokenImage)} alt="" className="object-cover flex-shrink-0" style={{ width: size, height: size }} />
}

export function NotificationRow({ notification, onClick, onMute, compact }: NotificationRowProps) {
  const size = compact ? 28 : 32
  const href = notificationHref(notification)
  const unread = !notification.read

  return (
    <div className="group relative">
      <Link
        href={href}
        onClick={onClick}
        className={`flex items-start gap-2.5 px-3 py-2.5 hover:bg-[#1e1e1e] transition-colors ${
          unread ? 'border-l-2 border-[#8B5CF6]' : 'border-l-2 border-transparent'
        }`}
      >
        <div className="flex-shrink-0 mt-0.5">
          <NotificationLeft n={notification} size={size} />
        </div>
        <div className="flex-1 min-w-0">
          <NotificationContent n={notification} />
        </div>
        {unread && (
          <div className="w-1.5 h-1.5 rounded-full bg-[#8B5CF6] mt-2 flex-shrink-0" aria-label="unread" />
        )}
      </Link>

      {onMute && notification.actor && (
        <button
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onMute(notification.actor!)
          }}
          className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity text-[9px] font-mono uppercase tracking-widest text-[#333] hover:text-[#888] px-1 py-0.5"
          title={`Mute ${notification.actor}`}
        >
          mute
        </button>
      )}
    </div>
  )
}
