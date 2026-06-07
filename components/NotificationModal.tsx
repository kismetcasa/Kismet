'use client'

import { useCallback, useEffect, useState } from 'react'
import { X, Settings, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { NotificationFeed } from './NotificationFeed'
import { ProfileAvatar } from './ProfileAvatar'
import { SignInPrompt } from './SignInPrompt'
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
  autocollect: 'Your agent auto-collects',
}

// Labels used in the FC push section. We surface every type here (the
// mute section omits non-muteable ones) because push opt-in is the
// inverse: financial types default to OFF and the user opts INTO them.
const PUSH_TYPE_LABELS: Record<NotificationType, string> = {
  collect: 'Someone collects your work',
  sale: 'Sales of your listings',
  follow: 'New followers',
  mint: 'New mints from people you follow',
  listing_expired: 'Your listings expire',
  listing_created: 'New listings from people you follow',
  airdrop: 'Airdrops you receive',
  payout: 'Splits and payouts',
  authorized: 'Creator authorizations',
  autocollect: 'Your agent auto-collects',
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
  // FC push: enabled = set of types the user has opted IN to push for.
  // pushAllTypes mirrors ALL_NOTIFICATION_TYPES sent by the server so
  // the order/labels don't drift if we add a type later.
  const [pushEnabled, setPushEnabled] = useState<NotificationType[] | null>(null)
  const [pushAllTypes, setPushAllTypes] = useState<NotificationType[]>([])
  const [pushHasTokens, setPushHasTokens] = useState<boolean>(false)
  const [pushHasFid, setPushHasFid] = useState<boolean>(false)
  const [pushLoading, setPushLoading] = useState(false)
  // Master toggle (default off). Gates all push regardless of per-type.
  // Auto-flipped on by the server during the user's first
  // notifications_enabled webhook so the "Add Kismet" prompt's promise
  // still works without an extra trip to settings.
  const [pushMaster, setPushMaster] = useState<boolean>(false)
  // 401 from any settings-tab GET flips this so the tab renders
  // <SignInPrompt /> instead of three blank sections.
  const [authRequired, setAuthRequired] = useState(false)

  useBodyScrollLock()
  useEscapeKey(onClose)

  // useCallback so both the tab-mount useEffect and SignInPrompt's
  // onSignedIn can re-run it. .catch paths null out the lists on
  // non-401 failures so partial outages don't show stale data.
  const refetchSettings = useCallback(() => {
    setMutedLoading(true)
    setTypesLoading(true)
    setPushLoading(true)
    fetch('/api/notifications/mute', { credentials: 'same-origin' })
      .then((r) => {
        if (r.status === 401) { setAuthRequired(true); return Promise.reject() }
        return r.ok ? r.json() : Promise.reject()
      })
      .then((d) => setMuted(Array.isArray(d.muted) ? d.muted : []))
      .catch(() => setMuted([]))
      .finally(() => setMutedLoading(false))
    fetch('/api/notifications/mute-type', { credentials: 'same-origin' })
      .then((r) => {
        if (r.status === 401) { setAuthRequired(true); return Promise.reject() }
        return r.ok ? r.json() : Promise.reject()
      })
      .then((d) => {
        setMutedTypes(Array.isArray(d.muted) ? d.muted : [])
        setMuteableTypes(Array.isArray(d.muteable) ? d.muteable : [])
      })
      .catch(() => {
        setMutedTypes([])
        setMuteableTypes([])
      })
      .finally(() => setTypesLoading(false))
    fetch('/api/notifications/push-types', { credentials: 'same-origin' })
      .then((r) => {
        if (r.status === 401) { setAuthRequired(true); return Promise.reject() }
        return r.ok ? r.json() : Promise.reject()
      })
      .then((d) => {
        setPushEnabled(Array.isArray(d.enabled) ? d.enabled : [])
        setPushAllTypes(Array.isArray(d.all) ? d.all : [])
        setPushHasTokens(!!d.hasTokens)
        setPushHasFid(typeof d.fid === 'number' && d.fid > 0)
        setPushMaster(!!d.master)
      })
      .catch(() => {
        setPushEnabled([])
        setPushAllTypes([])
        setPushHasTokens(false)
        setPushHasFid(false)
        setPushMaster(false)
      })
      .finally(() => setPushLoading(false))
  }, [])

  // Reset authRequired on each settings-tab mount so a stale 401
  // doesn't hide the freshly-loaded data.
  useEffect(() => {
    if (tab !== 'settings') return
    setAuthRequired(false)
    refetchSettings()
  }, [tab, refetchSettings])

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

  async function handleTogglePush(type: NotificationType) {
    const previous = pushEnabled
    const wasEnabled = previous?.includes(type) ?? false
    setPushEnabled((prev) => {
      if (!prev) return prev
      return wasEnabled ? prev.filter((t) => t !== type) : [...prev, type]
    })
    try {
      await ensureSession()
      const res = await fetch('/api/notifications/push-types', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, enabled: !wasEnabled }),
      })
      if (!res.ok) throw new Error('request failed')
    } catch (err) {
      setPushEnabled(previous)
      const description = humanError(err)
      if (description === 'Cancelled') return
      toast.error('Update failed', { description })
    }
  }

  async function handleToggleMaster() {
    const previous = pushMaster
    const next = !previous
    setPushMaster(next)
    try {
      await ensureSession()
      const res = await fetch('/api/notifications/push-types', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ master: next }),
      })
      if (!res.ok) throw new Error('request failed')
    } catch (err) {
      setPushMaster(previous)
      const description = humanError(err)
      if (description === 'Cancelled') return
      toast.error('Update failed', { description })
    }
  }

  // Nav is h-14 + safe-top tall — anchor backdrop + panel to clear it.
  // Bottom of the panel extends to the screen edge; the scrollable body
  // below pads itself by --safe-bottom so the last row clears the home
  // indicator without leaving an unstyled gap below the panel chrome.
  const topOffset = { top: 'calc(3.5rem + var(--safe-top))' }

  return (
    <>
      {/* Backdrop — covers page below nav, click to close */}
      <div
        className="fixed inset-x-0 bottom-0 z-[59] bg-black/50"
        style={topOffset}
        onClick={onClose}
      />

      {/* Drawer panel */}
      <div
        className="fixed right-0 bottom-0 z-[60] w-full max-w-[440px] bg-[#0d0d0d] border-l border-line flex flex-col"
        style={topOffset}
      >

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

        {/* Scrollable body — pad the bottom so the last visible row clears
            the device's home indicator on mobile FC. 0 on web. */}
        <div className="flex-1 overflow-y-auto" style={{ paddingBottom: 'var(--safe-bottom)' }}>
          {tab === 'feed' ? (
            <NotificationFeed />
          ) : authRequired ? (
            <SignInPrompt
              message="sign in to manage notifications"
              onSignedIn={() => {
                setAuthRequired(false)
                refetchSettings()
              }}
            />
          ) : (
            <div className="p-4 flex flex-col gap-6">
              <div>
                <p className="text-[10px] font-mono uppercase tracking-widest text-muted mb-1">
                  mobile push (farcaster)
                </p>
                <p className="text-[10px] font-mono text-[#444] mb-3">
                  {pushHasTokens
                    ? 'native farcaster push. master toggle gates everything below.'
                    : pushHasFid
                      ? 'add kismet inside farcaster to enable mobile push.'
                      : 'connect a farcaster-linked wallet to enable mobile push.'}
                </p>
                {pushLoading ? (
                  <div className="flex justify-center py-4">
                    <Loader2 size={14} className="animate-spin text-muted" />
                  </div>
                ) : !pushHasTokens ? (
                  // Locked state: no tokens means no surface to push to.
                  // Render the list disabled so users see what's coming
                  // once they add Kismet, but every toggle is inert.
                  <div className="flex flex-col gap-1.5 opacity-50">
                    <div className="flex items-center justify-between px-3 py-2 border border-line">
                      <span className="text-xs font-mono text-ink">
                        All mobile push notifications
                      </span>
                      <span className="text-[9px] font-mono uppercase tracking-widest text-[#444]">
                        off
                      </span>
                    </div>
                    {pushAllTypes.map((type) => (
                      <div
                        key={type}
                        className="flex items-center justify-between px-3 py-2 border border-line"
                      >
                        <span className="text-xs font-mono text-dim">
                          {PUSH_TYPE_LABELS[type] ?? type}
                        </span>
                        <span className="text-[9px] font-mono uppercase tracking-widest text-[#444]">
                          off
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {/* Master row: visually distinct (brighter label, no
                        sub-row indent) so users see this gates everything. */}
                    <div className="flex items-center justify-between px-3 py-2 border border-line bg-[#141414]">
                      <span className="text-xs font-mono text-ink">
                        All mobile push notifications
                      </span>
                      <button
                        onClick={handleToggleMaster}
                        className={`text-[9px] font-mono uppercase tracking-widest transition-colors ${
                          pushMaster
                            ? 'text-ink hover:text-dim'
                            : 'text-muted hover:text-ink'
                        }`}
                      >
                        {pushMaster ? 'on' : 'off'}
                      </button>
                    </div>
                    {/* Per-type list. Visually inert (and effectively
                        inert on the server) when master is off, so the
                        user never sees a toggle they think works but
                        actually doesn't. */}
                    <div
                      className={`flex flex-col gap-1.5 transition-opacity ${
                        pushMaster ? '' : 'opacity-40 pointer-events-none select-none'
                      }`}
                      aria-disabled={!pushMaster}
                    >
                      {pushAllTypes.map((type) => {
                        const isOn = pushEnabled?.includes(type) ?? false
                        return (
                          <div
                            key={type}
                            className="flex items-center justify-between px-3 py-2 border border-line"
                          >
                            <span className="text-xs font-mono text-dim">
                              {PUSH_TYPE_LABELS[type] ?? type}
                            </span>
                            <button
                              onClick={() => handleTogglePush(type)}
                              disabled={!pushMaster}
                              className={`text-[9px] font-mono uppercase tracking-widest transition-colors ${
                                isOn
                                  ? 'text-ink hover:text-dim'
                                  : 'text-muted hover:text-ink'
                              }`}
                            >
                              {isOn ? 'on' : 'off'}
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
                <p className="text-[10px] font-mono text-[#444] mt-2">
                  muting a type or account below also silences its push.
                </p>
              </div>

              <div>
                <p className="text-[10px] font-mono uppercase tracking-widest text-muted mb-3">
                  hide from feed
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
