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

type ModalTab = 'feed' | 'settings'

interface NotificationModalProps {
  onClose: () => void
}

export function NotificationModal({ onClose }: NotificationModalProps) {
  const { ensureSession } = useUploadSession()
  const [tab, setTab] = useState<ModalTab>('feed')
  const [muted, setMuted] = useState<string[] | null>(null)
  const [mutedLoading, setMutedLoading] = useState(false)

  useBodyScrollLock()
  useEscapeKey(onClose)

  // Fetch muted list when settings tab is first opened
  useEffect(() => {
    if (tab !== 'settings') return
    setMutedLoading(true)
    fetch('/api/notifications/mute', { credentials: 'same-origin' })
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setMuted(Array.isArray(d.muted) ? d.muted : []))
      .catch(() => setMuted([]))
      .finally(() => setMutedLoading(false))
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
    } catch (err) {
      setMuted(previous)
      const description = humanError(err)
      if (description === 'Cancelled') return
      toast.error('Unmute failed', { description })
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
      <div className="fixed right-0 top-14 bottom-0 z-[60] w-full max-w-[440px] bg-[#0d0d0d] border-l border-[#2a2a2a] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#2a2a2a] flex-shrink-0">
          <p className="text-[10px] font-mono uppercase tracking-widest text-[#888]">
            {tab === 'settings' ? 'notification settings' : 'notifications'}
          </p>
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setTab((t) => t === 'settings' ? 'feed' : 'settings')}
              title={tab === 'settings' ? 'back to feed' : 'notification settings'}
              className={`p-1.5 transition-colors rounded ${
                tab === 'settings' ? 'text-[#efefef]' : 'text-[#444] hover:text-[#888]'
              }`}
            >
              <Settings size={13} />
            </button>
            <button
              onClick={onClose}
              title="close"
              className="p-1.5 text-[#444] hover:text-[#efefef] transition-colors"
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
            <div className="p-4 flex flex-col gap-4">
              <div>
                <p className="text-[10px] font-mono uppercase tracking-widest text-[#555] mb-3">
                  muted accounts
                </p>
                {mutedLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 size={14} className="animate-spin text-[#555]" />
                  </div>
                ) : !muted || muted.length === 0 ? (
                  <p className="text-xs font-mono text-[#555]">no muted accounts</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {muted.map((actor) => (
                      <div
                        key={actor}
                        className="flex items-center justify-between px-3 py-2 border border-[#2a2a2a]"
                      >
                        <div className="flex items-center gap-2">
                          <ProfileAvatar address={actor} size={20} />
                          <span className="text-xs font-mono text-[#888]">
                            {shortAddress(actor)}
                          </span>
                          <CopyAddress address={actor} size={11} />
                        </div>
                        <button
                          onClick={() => handleUnmute(actor)}
                          className="text-[9px] font-mono uppercase tracking-widest text-[#555] hover:text-[#efefef] transition-colors"
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
