'use client'

import Link from 'next/link'
import { Sparkles, Clock } from 'lucide-react'
import { ProfileAvatar } from './ProfileAvatar'
import { shortAddress, formatRelativeTime, formatPrice, resolveUri } from '@/lib/inprocess'
import type { Notification } from '@/lib/notifications'

interface NotificationRowProps {
  notification: Notification
  // Resolved display name for `notification.actor`, batch-fetched by the
  // parent feed via profileCache. Falls back to shortAddress when missing.
  actorName?: string
  onClick?: () => void
  onMute?: (actor: string) => void
}

function notificationHref(n: Notification): string {
  switch (n.type) {
    case 'follow':
      return n.actor ? `/profile/${n.actor}` : '/'
    case 'collect':
    case 'sale':
    case 'mint':
    case 'listing_expired':
    case 'airdrop':
      return n.tokenAddress && n.tokenId ? `/moment/${n.tokenAddress}/${n.tokenId}` : '/'
  }
}

function NotificationContent({ n, actorName }: { n: Notification; actorName?: string }) {
  const time = formatRelativeTime(n.timestamp)
  // Prefer the resolved display name (username/ENS) when available; fall
  // back to the shortened address. Memoized in the parent so this is just
  // a lookup.
  const actorLabel = n.actor ? (actorName ?? shortAddress(n.actor)) : null

  switch (n.type) {
    case 'collect':
      return (
        <>
          <p className="text-xs font-mono text-[#efefef] truncate">
            {actorLabel ?? 'someone'} collected {n.tokenName ? `"${n.tokenName}"` : 'your moment'}
          </p>
          {n.comment && (
            <p className="text-[10px] font-mono text-[#888] mt-0.5 truncate">"{n.comment}"</p>
          )}
          <p className="text-[10px] font-mono text-[#555] mt-0.5 truncate">
            {n.amount && n.amount > 1 ? `${n.amount} editions` : '1 edition'}
            {n.price ? ` · ${formatPrice(n.price, n.currency ?? 'eth')}` : ''} · {time}
          </p>
        </>
      )
    case 'sale':
      return (
        <>
          <p className="text-xs font-mono text-[#efefef] truncate">
            {actorLabel ? `${actorLabel} bought your listing` : 'your listing was filled'}
          </p>
          <p className="text-[10px] font-mono text-[#555] mt-0.5 truncate">
            {n.tokenName ?? 'untitled'}{n.price ? ` · ${formatPrice(n.price, n.currency ?? 'eth')}` : ''} · {time}
          </p>
        </>
      )
    case 'follow':
      return (
        <>
          <p className="text-xs font-mono text-[#efefef] truncate">
            {actorLabel ?? 'someone'} followed you
          </p>
          <p className="text-[10px] font-mono text-[#555] mt-0.5 truncate">{time}</p>
        </>
      )
    case 'mint':
      // Self-notification (no actor) = "your moment was created" — confirms
      // the user's own create action. Follower-fanout (actor set) = "@addr
      // minted X" — surfaces creates by people you follow.
      if (actorLabel) {
        return (
          <>
            <p className="text-xs font-mono text-[#efefef] truncate">
              {actorLabel} minted {n.tokenName ? `"${n.tokenName}"` : 'a moment'}
            </p>
            <p className="text-[10px] font-mono text-[#555] mt-0.5 truncate">{time}</p>
          </>
        )
      }
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
            {n.tokenName ?? 'untitled'}{n.price ? ` · ${formatPrice(n.price, n.currency ?? 'eth')}` : ''} · {time}
          </p>
        </>
      )
    case 'airdrop':
      return (
        <>
          <p className="text-xs font-mono text-[#efefef] truncate">
            {actorLabel ?? 'someone'} airdropped you {n.tokenName ? `"${n.tokenName}"` : 'a moment'}
          </p>
          <p className="text-[10px] font-mono text-[#555] mt-0.5 truncate">{time}</p>
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

export function NotificationRow({ notification, actorName, onClick, onMute }: NotificationRowProps) {
  const size = 32
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
          <NotificationContent n={notification} actorName={actorName} />
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
