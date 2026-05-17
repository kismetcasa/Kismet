'use client'

import { useEffect, useState } from 'react'
import { X, Settings, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { NotificationFeed } from './NotificationFeed'
import { ProfileAvatar } from './ProfileAvatar'
import { useUploadSession } from '@/hooks/useUploadSession'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'
import { humanError } from '@/lib/toast'
import { shortAddress } from '@/lib/inprocess'
import { CopyAddress } from './CopyAddress'
import type { NotificationType } from '@/lib/notifications'

const TYPE_LABELS: Record<string, string> = {
  collect: 'Collects',
  follow: 'New followers',
  mint: 'Mints by people you follow',
  listing_expired: 'Your listings expired',
  listing_created: 'Listings by people you follow',
  authorized: 'Creator authorizations',
}

type ModalTab = 'feed' | 'settings'

interface NotificationModalProps {
  onClose: () => void
}

export function NotificationModal({ onClose }: NotificationModalProps) {
  const { ensureSession } = useUploadSession()
  const [tab, setTab] = useState<ModalTab>('feed')
  const [muted, setMuted] = useState<string[] | null>(null)
  const [mutedLoading, setMutedLoading] = useState(false)
  const [mutedTypes, setMutedTypes] = useState<NotificationType[] | null>(null)
  const [muteableTypes, setMuteableTypes] = useState<NotificationType[]>([])
  const [typesLoading, setTypesLoading] = useState(false)

  useBodyScrollLock()
  useEscapeKey(onClose)

  // Fetch mute lists when settings tab is first opened
  useEffect(() => {
    if (tab !== 'settings') return
    setMutedLoading(true)
    setTypesLoading(true)
    fetch('/api/notifications/mute', { credentials: 'same-origin' })
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setMuted(Array.isArray(d.muted) ? d.muted : []))
      .catch(() => setMuted([]))
      .finally(() => setMutedLoading(false))
    fetch('/api/notifications/mute-type', { credentials: 'same-origin' })
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => {
        setMutedTypes(Array.isArray(d.muted) ? d.muted : [])
        setMuteableTypes(Array.isArray(d.muteable) ? d.muteable : [])
      })
      .catch(() => {
        setMutedTypes([])
        setMuteableTypes([])
      })
      .finally(() => setTypesLoading(false))
  }, [tab])

  async function handleUnmute(actor: string) {
    const previous = muted
    setMuted((prev) => prev?.filter((a) => a !== actor) ?? null)
    try {
      await ensureSession()
      await fetch('/api/notifications/mute', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor, unmute: true }),
      })
      // Actor-mute filters at read time, so unmuting can resurface
      // priority rows — tell the bell to re-verify its count.
      window.dispatchEvent(new CustomEvent('kismetart:notif-refetch'))
    } catch (err) {
      setMuted(previous)
      const description = humanError(err)
      if (description === 'Cancelled') return
      toast.error('Unmute failed', { description })
    }
  }

  async function handleToggleType(type: NotificationType) {
    const previous = mutedTypes
    const wasMuted = previous?.includes(type) ?? false
    setMutedTypes((prev) => {
      if (!prev) return prev
      return wasMuted ? prev.filter((t) => t !== type) : [...prev, type]
    })
    try {
      await ensureSession()
      const res = await fetch('/api/notifications/mute-type', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, unmute: wasMuted }),
      })
      if (!res.ok) throw new Error('request failed')
    } catch (err) {
      setMutedTypes(previous)
      const description = humanError(err)
      if (description === 'Cancelled') return
      toast.error('Update failed', { description })
    }
  }

  return (
    <>
      {/* Backdrop — covers page below nav, click to close */}
      <div
        className="fixed inset-x-0 top-14 bottom-0 z-[59] bg-black/50"
        onClick={onClose}
      />

      {/* Drawer panel */}
      <div className="fixed right-0 top-14 bottom-0 z-[60] w-full max-w-[440px] bg-[#0d0d0d] border-l border-line flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-line flex-shrink-0">
          <p className="text-[10px] font-mono uppercase tracking-widest text-dim">
            {tab === 'settings' ? 'notification settings' : 'notifications'}
          </p>
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setTab((t) => t === 'settings' ? 'feed' : 'settings')}
              title={tab === 'settings' ? 'back to feed' : 'notification settings'}
              className={`p-1.5 transition-colors rounded ${
                tab === 'settings' ? 'text-ink' : 'text-[#444] hover:text-dim'
              }`}
            >
              <Settings size={13} />
            </button>
            <button
              onClick={onClose}
              title="close"
              className="p-1.5 text-[#444] hover:text-ink transition-colors"
            >
              <X size={13} />
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto">
          {tab === 'feed' ? (
            <NotificationFeed />
          ) : (
            <div className="p-4 flex flex-col gap-6">
              <div>
                <p className="text-[10px] font-mono uppercase tracking-widest text-muted mb-3">
                  notification types
                </p>
                {typesLoading ? (
                  <div className="flex justify-center py-4">
                    <Loader2 size={14} className="animate-spin text-muted" />
                  </div>
                ) : muteableTypes.length === 0 ? (
                  <p className="text-xs font-mono text-muted">no types available</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {muteableTypes.map((type) => {
                      const isMuted = mutedTypes?.includes(type) ?? false
                      return (
                        <div
                          key={type}
                          className="flex items-center justify-between px-3 py-2 border border-line"
                        >
                          <span className="text-xs font-mono text-dim">
                            {TYPE_LABELS[type] ?? type}
                          </span>
                          <button
                            onClick={() => handleToggleType(type)}
                            className="text-[9px] font-mono uppercase tracking-widest text-muted hover:text-ink transition-colors"
                          >
                            {isMuted ? 'unmute' : 'mute'}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
                <p className="text-[10px] font-mono text-[#444] mt-2">
                  sales, airdrops and payouts always notify.
                </p>
              </div>

              <div>
                <p className="text-[10px] font-mono uppercase tracking-widest text-muted mb-3">
                  muted accounts
                </p>
                {mutedLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 size={14} className="animate-spin text-muted" />
                  </div>
                ) : !muted || muted.length === 0 ? (
                  <p className="text-xs font-mono text-muted">no muted accounts</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {muted.map((actor) => (
                      <div
                        key={actor}
                        className="flex items-center justify-between px-3 py-2 border border-line"
                      >
                        <div className="flex items-center gap-2">
                          <ProfileAvatar address={actor} size={20} />
                          <span className="text-xs font-mono text-dim">
                            {shortAddress(actor)}
                          </span>
                          <CopyAddress address={actor} size={11} />
                        </div>
                        <button
                          onClick={() => handleUnmute(actor)}
                          className="text-[9px] font-mono uppercase tracking-widest text-muted hover:text-ink transition-colors"
                        >
                          unmute
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

      </div>
    </>
  )
}
