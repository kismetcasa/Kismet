'use client'

import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { toastError } from '@/lib/toast'
import { MomentImg } from './MomentImage'
import type { Moment } from '@/lib/inprocess'
import type { ProfileTheme, ThemeMotion } from '@/lib/profileTheme'

interface CustomizePanelProps {
  address: string
  /** The owner's mints + collected, already loaded by ProfileView — the theme
   *  source must be one of these (the route re-validates ownership server-side). */
  moments: Moment[]
  collected: Moment[]
  theme: ProfileTheme | null
  /** Lifts the new theme to ProfileView so the re-skin / ring / backdrop apply
   *  live, no reload. */
  onThemeChange: (theme: ProfileTheme | null) => void
  onClose: () => void
}

// Owner-only modal to set/clear the content-derived profile theme. Picks from
// the already-loaded mints/collected (no new fetch); a tap POSTs the ref, the
// server extracts the palette, and the result is applied live. Lazy <img>
// tiles (MomentImg) so a large grid doesn't eager-load on open.
export function CustomizePanel({ address, moments, collected, theme, onThemeChange, onClose }: CustomizePanelProps) {
  const [tab, setTab] = useState<'mints' | 'collected'>('mints')
  const [pending, setPending] = useState<string | null>(null)
  const items = tab === 'mints' ? moments : collected
  const activeRef = theme?.momentRef ?? null

  async function pick(m: Moment) {
    if (pending) return
    const ref = `${m.address.toLowerCase()}:${m.token_id}`
    setPending(ref)
    try {
      const res = await fetch(`/api/profile/${address}/theme`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collectionAddress: m.address, tokenId: m.token_id, motion: theme?.motion }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error ?? 'Failed')
      }
      const { theme: next } = await res.json()
      opSeq.current++ // supersede any in-flight optimistic revert
      onThemeChange(next)
      toast.success('Theme applied')
    } catch (err) {
      toastError('Theme', err)
    } finally {
      setPending(null)
    }
  }

  async function remove() {
    if (pending) return
    setPending('__remove__')
    try {
      const res = await fetch(`/api/profile/${address}/theme`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed')
      opSeq.current++ // supersede any in-flight optimistic revert
      onThemeChange(null)
      toast.success('Theme removed')
    } catch (err) {
      toastError('Theme', err)
    } finally {
      setPending(null)
    }
  }

  // Ambient-motion prefs (bloom / mesh / hue). Optimistic: lift the merged theme
  // so the backdrop re-animates instantly, then persist via PATCH (no
  // re-extraction). The slider commits debounced so dragging it doesn't hammer
  // the store. The viewer's prefers-reduced-motion still wins (the keyframes
  // live only in the no-preference query), so these only express owner intent.
  const motion = theme?.motion
  const hueRange = motion?.hueRange ?? 20
  // first match: a near-monochrome palette can clamp two swatches to the same
  // hex, so the highlight may land on an identical-looking one (cosmetic).
  const activeIdx = theme ? theme.palette.ringStops.indexOf(theme.palette.primary) : -1
  const patchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Monotonic guard so a failed optimistic PATCH only reverts if no newer theme
  // mutation (another pick / accent / motion edit) has superseded it — without it
  // a late failure would clobber the current theme with a stale snapshot.
  const opSeq = useRef(0)

  // Cancel a pending debounced PATCH if the panel closes mid-edit, so it can't
  // fire (and revert) after unmount.
  useEffect(() => () => { if (patchTimer.current) clearTimeout(patchTimer.current) }, [])

  function commitMotion(next: ThemeMotion, debounce = false) {
    if (!theme) return
    const prev = theme
    const myseq = ++opSeq.current
    onThemeChange({ ...theme, motion: next })
    if (patchTimer.current) clearTimeout(patchTimer.current)
    const run = async () => {
      try {
        const res = await fetch(`/api/profile/${address}/theme`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ motion: next }),
        })
        if (!res.ok) throw new Error('Failed')
      } catch (err) {
        if (opSeq.current === myseq) onThemeChange(prev) // only if not superseded by a newer edit
        toastError('Motion', err)
      }
    }
    if (debounce) patchTimer.current = setTimeout(run, 500)
    else run()
  }

  // Re-pick which palette color is the accent. ringStops are already
  // contrast-clamped, so this is just primary := ringStops[i] — no
  // re-extraction, the ring/backdrop/mesh stay put. Optimistic + revert-on-error.
  async function pickAccent(i: number) {
    if (!theme) return
    const ringStops = theme.palette.ringStops
    if (i < 0 || i >= ringStops.length) return
    const prev = theme
    const myseq = ++opSeq.current
    onThemeChange({ ...theme, palette: { ...theme.palette, primary: ringStops[i] } })
    try {
      const res = await fetch(`/api/profile/${address}/theme`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ primaryIndex: i }),
      })
      if (!res.ok) throw new Error('Failed')
    } catch (err) {
      if (opSeq.current === myseq) onThemeChange(prev)
      toastError('Accent', err)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-lg bg-[#161616] border border-line flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <p className="text-xs font-mono text-dim uppercase tracking-wider">Customize profile</p>
          <button onClick={onClose} className="p-1 text-muted hover:text-dim transition-colors" title="close">
            <X size={14} />
          </button>
        </div>

        {theme && (
          <div className="flex items-center gap-3 px-5 py-3 border-b border-line">
            <div className="flex gap-1.5">
              {theme.palette.ringStops.slice(0, 5).map((c, i) => {
                const active = i === activeIdx
                return (
                  <button
                    key={i}
                    onClick={() => pickAccent(i)}
                    title={active ? 'current accent' : 'use as accent'}
                    aria-label={active ? 'current accent' : 'set as accent'}
                    className={`w-5 h-5 rounded transition-transform hover:scale-110 ${
                      active ? 'ring-2 ring-ink ring-offset-1 ring-offset-[#161616]' : ''
                    }`}
                    style={{ background: c }}
                  />
                )
              })}
            </div>
            <span className="text-[11px] font-mono text-muted flex-1">tap a color to set accent</span>
            <button
              onClick={remove}
              disabled={!!pending}
              className="text-[11px] font-mono px-2 py-1 border border-line text-muted hover:border-red-900 hover:text-red-400 transition-colors disabled:opacity-40"
            >
              remove
            </button>
          </div>
        )}

        {/* Ambient-motion toggles + hue slider. Always shown so the controls
            are discoverable; disabled (grayed) until a theme exists, since
            there's nothing to animate without one. All default off. */}
        <div className="flex flex-col gap-2 px-5 py-3 border-b border-line">
          <p className="text-[10px] font-mono text-muted uppercase tracking-wider">Motion</p>
          <div className="flex gap-2">
            {(theme && theme.mediaType !== 'image'
              ? (['bloom', 'mesh', 'hue', 'live'] as const)
              : (['bloom', 'mesh', 'hue'] as const)
            ).map((k) => {
              const on = !!motion?.[k]
              return (
                <button
                  key={k}
                  disabled={!theme}
                  onClick={() => commitMotion({ ...motion, [k]: !on } as ThemeMotion)}
                  className={`text-[11px] font-mono px-2.5 py-1 border transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                    on ? 'border-accent/50 text-accent' : 'border-line text-muted hover:text-dim'
                  }`}
                >
                  {k}
                </button>
              )
            })}
          </div>
          {theme && motion?.hue && (
            <div className="flex items-center gap-2 pt-1">
              <span className="text-[10px] font-mono text-muted w-7">range</span>
              <input
                type="range"
                min={10}
                max={360}
                step={10}
                value={hueRange}
                style={{ accentColor: theme.palette.primary }}
                onChange={(e) => commitMotion({ ...motion, hue: true, hueRange: Number(e.target.value) }, true)}
                className="flex-1 h-1 cursor-pointer"
                aria-label="hue range"
              />
              <span className="text-[10px] font-mono text-dim w-9 text-right">
                {hueRange >= 360 ? 'full' : `${hueRange}°`}
              </span>
            </div>
          )}
          {!theme && <p className="text-[10px] font-mono text-faint">select a theme below to enable motion</p>}
        </div>

        <p className="px-5 pt-3 text-[11px] font-mono text-muted">
          Pick a mint or collected moment — its colors theme your profile.
        </p>

        <div className="flex gap-2 px-5 py-3">
          {(['mints', 'collected'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`text-[11px] font-mono px-2.5 py-1 border transition-colors ${
                tab === t ? 'border-accent/50 text-accent' : 'border-line text-muted hover:text-dim'
              }`}
            >
              {t === 'mints' ? `Mints (${moments.length})` : `Collected (${collected.length})`}
            </button>
          ))}
        </div>

        <div className="overflow-y-auto px-5 pb-5 grid grid-cols-3 sm:grid-cols-4 gap-2">
          {items.length === 0 ? (
            <p className="col-span-full text-[11px] font-mono text-muted py-6 text-center">nothing here yet</p>
          ) : (
            items.map((m) => {
              const ref = `${m.address.toLowerCase()}:${m.token_id}`
              const isActive = ref === activeRef
              const isPending = pending === ref
              return (
                <button
                  key={m.id ?? ref}
                  onClick={() => pick(m)}
                  disabled={!!pending}
                  title={m.metadata?.name ?? 'moment'}
                  className={`relative aspect-square overflow-hidden border transition-colors disabled:cursor-not-allowed ${
                    isActive ? 'border-accent' : 'border-line hover:border-dim'
                  }`}
                >
                  {m.metadata?.image ? (
                    <MomentImg src={m.metadata.image} alt="" className="absolute inset-0 w-full h-full object-cover" />
                  ) : (
                    <div className="absolute inset-0 bg-surface" />
                  )}
                  {isActive && (
                    <span className="absolute bottom-1 left-1 text-[9px] font-mono text-ink bg-black/70 px-1.5 py-0.5">
                      active
                    </span>
                  )}
                  {isPending && (
                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                      <span className="text-[10px] font-mono text-ink animate-pulse">…</span>
                    </div>
                  )}
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
