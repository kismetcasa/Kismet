'use client'

import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { toastError } from '@/lib/toast'
import { MomentImage } from './MomentImage'
import { resolveMomentMedia } from '@/lib/media/resolveMomentMedia'
import { thumbhashToBlurDataURL } from '@/lib/media/thumbhash'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'
import type { Moment } from '@/lib/inprocess'
import type { Listing } from '@/lib/listings'
import type { ProfileTheme, ThemeMotion } from '@/lib/profileTheme'

interface CustomizePanelProps {
  address: string
  /** The owner's mints / collected / listings, already loaded by ProfileView —
   *  the theme source must be one of these (the route re-validates ownership:
   *  minted, collected, or actively listed). */
  moments: Moment[]
  collected: Moment[]
  listings: Listing[]
  theme: ProfileTheme | null
  /** Lifts the new theme to ProfileView so the re-skin / ring / backdrop apply
   *  live, no reload. */
  onThemeChange: (theme: ProfileTheme | null) => void
  onClose: () => void
}

// A theme "source" — one of the owner's owned moments, normalized to what a
// picker tile needs. The route re-validates ownership server-side.
interface Source {
  ref: string
  collectionAddress: string
  tokenId: string
  still?: string
  thumbhash?: string
  name?: string
}

// Resolve the real still through the SAME path the profile cards use
// (resolveMomentMedia → video poster / gif / content.uri), so video / animated
// moments get a still instead of the blank tiles the old metadata.image-only
// picker produced.
function momentSource(m: Moment): Source {
  const r = resolveMomentMedia(m.metadata ?? {})
  const still = r.kind === 'video' ? (r.poster ?? m.metadata?.image) : (r.poster ?? r.src ?? m.metadata?.image)
  return {
    ref: `${m.address.toLowerCase()}:${m.token_id}`,
    collectionAddress: m.address,
    tokenId: m.token_id,
    still,
    thumbhash: m.metadata?.kismet_thumbhash,
    name: m.metadata?.name,
  }
}
function listingSource(l: Listing): Source {
  return { ref: `${l.collectionAddress.toLowerCase()}:${l.tokenId}`, collectionAddress: l.collectionAddress, tokenId: l.tokenId, still: l.image, name: l.name }
}

// Robust selectable tile: MomentImage (multi-gateway + thumbhash + onAllError)
// so every owned moment renders, with a "no preview" fallback if all gateways
// fail — never a silent blank.
function SourceTile({ src, thumbhash, name, active, disabled, pending, onClick }: {
  src?: string; thumbhash?: string; name?: string; active: boolean; disabled: boolean; pending: boolean; onClick: () => void
}) {
  const [failed, setFailed] = useState(false)
  // When there's no still for the <img> (a poster-less video) or every gateway
  // fails, fall back to the thumbhash blur so the tile still shows the moment's
  // colors — and it's pickable, theming from that same thumbhash. Only a moment
  // with neither a still nor a thumbhash stays "no preview".
  const blur = thumbhash ? thumbhashToBlurDataURL(thumbhash) : undefined
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={name ?? 'artwork'}
      className={`relative aspect-square overflow-hidden border transition-colors disabled:cursor-not-allowed ${active ? 'border-accent' : 'border-line hover:border-dim'}`}
    >
      {src && !failed ? (
        <MomentImage src={src} thumbhash={thumbhash} alt="" fill sizes="200px" className="object-cover" preferProxy onAllError={() => setFailed(true)} />
      ) : blur ? (
        <div className="absolute inset-0" style={{ backgroundImage: `url(${blur})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
      ) : (
        <div className="absolute inset-0 bg-surface flex items-center justify-center"><span className="text-line font-mono text-[9px]">no preview</span></div>
      )}
      {active && <span className="absolute bottom-1 left-1 text-[9px] font-mono text-ink bg-black/70 px-1.5 py-0.5">current</span>}
      {pending && <div className="absolute inset-0 bg-black/50 flex items-center justify-center"><span className="text-[10px] font-mono text-ink animate-pulse">…</span></div>}
    </button>
  )
}

// Owner-only modal, two steps:
//   select — pick a source from the owner's own mints / collected / listed
//            moments (robust tiles, no new fetch — same URLs the profile already
//            loaded, so they cache-serve).
//   tune   — the selected moment + the variables to change (motion, accent,
//            remove). "change artwork" returns to select, keeping the current
//            theme live until a new one is picked (non-destructive).
// Opens straight to tune when a theme already exists, else to select.
export function CustomizePanel({ address, moments, collected, listings, theme, onThemeChange, onClose }: CustomizePanelProps) {
  const [step, setStep] = useState<'select' | 'tune'>(theme ? 'tune' : 'select')
  const [tab, setTab] = useState<'mints' | 'collected' | 'listings'>('mints')
  const [pending, setPending] = useState<string | null>(null)

  // Modal conventions, matching the Following/Followers modal: Escape closes,
  // and the page behind doesn't scroll while it's open.
  useEscapeKey(onClose, true)
  useBodyScrollLock(true)

  const motion = theme?.motion
  const hueRange = motion?.hueRange ?? 20
  // first match: a near-monochrome palette can clamp two swatches to the same
  // hex, so the highlight may land on an identical-looking one (cosmetic).
  const activeIdx = theme ? theme.palette.ringStops.indexOf(theme.palette.primary) : -1
  const activeRef = theme?.momentRef ?? null
  const patchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Monotonic guard so a failed optimistic PATCH only reverts if no newer theme
  // mutation has superseded it (else a late failure clobbers with a stale snapshot).
  const opSeq = useRef(0)
  useEffect(() => () => { if (patchTimer.current) clearTimeout(patchTimer.current) }, [])

  const sources: Source[] =
    tab === 'mints' ? moments.map(momentSource) : tab === 'collected' ? collected.map(momentSource) : listings.map(listingSource)

  async function pick(s: Source) {
    if (pending) return
    setPending(s.ref)
    try {
      const res = await fetch(`/api/profile/${address}/theme`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collectionAddress: s.collectionAddress, tokenId: s.tokenId, motion: theme?.motion }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error ?? 'Failed')
      }
      const { theme: next } = await res.json()
      opSeq.current++ // supersede any in-flight optimistic revert
      onThemeChange(next)
      setStep('tune')
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
      opSeq.current++
      onThemeChange(null)
      toast.success('Theme removed')
      onClose()
    } catch (err) {
      toastError('Theme', err)
    } finally {
      setPending(null)
    }
  }

  // Optimistic motion + accent edits (tune step), with the op-sequence guard.
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
        if (opSeq.current === myseq) onThemeChange(prev)
        toastError('Motion', err)
      }
    }
    if (debounce) patchTimer.current = setTimeout(run, 500)
    else run()
  }

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-full max-w-lg bg-[#161616] border border-line flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <p className="text-xs font-mono text-dim uppercase tracking-wider">{step === 'select' ? 'Pick an artwork' : 'Customize profile'}</p>
          <button onClick={onClose} className="p-1 text-muted hover:text-dim transition-colors" title="close"><X size={14} /></button>
        </div>

        {step === 'select' ? (
          <>
            <p className="px-5 pt-3 text-[11px] font-mono text-muted">Pick a mint, collected, or listed artwork — its colors theme your profile.</p>
            <div className="flex gap-2 px-5 py-3">
              {(['mints', 'collected', 'listings'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`text-[11px] font-mono px-2.5 py-1 border transition-colors ${tab === t ? 'border-accent/50 text-accent' : 'border-line text-muted hover:text-dim'}`}
                >
                  {t === 'mints' ? `Mints (${moments.length})` : t === 'collected' ? `Collected (${collected.length})` : `Listed (${listings.length})`}
                </button>
              ))}
            </div>
            <div className="overflow-y-auto px-5 pb-5 grid grid-cols-3 sm:grid-cols-4 gap-2">
              {sources.length === 0 ? (
                <p className="col-span-full text-[11px] font-mono text-muted py-6 text-center">nothing here yet</p>
              ) : (
                sources.map((s) => (
                  <SourceTile
                    key={s.ref}
                    src={s.still}
                    thumbhash={s.thumbhash}
                    name={s.name}
                    active={s.ref === activeRef}
                    disabled={!!pending}
                    pending={pending === s.ref}
                    onClick={() => pick(s)}
                  />
                ))
              )}
            </div>
          </>
        ) : theme ? (
          <div className="overflow-y-auto">
            {/* selected moment + change / remove */}
            <div className="flex items-center gap-3 px-5 py-3 border-b border-line">
              <div className="relative w-12 h-12 flex-shrink-0 overflow-hidden border border-line">
                {theme.mediaUrl ? (
                  <MomentImage src={theme.mediaUrl} thumbhash={theme.thumbhash} alt="" fill sizes="48px" className="object-cover" preferProxy />
                ) : (
                  <div className="absolute inset-0 bg-surface" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-mono text-ink truncate">{theme.momentName ?? 'themed artwork'}</p>
                <button onClick={() => setStep('select')} className="text-[10px] font-mono text-muted hover:text-accent transition-colors">change artwork</button>
              </div>
              <button
                onClick={remove}
                disabled={!!pending}
                className="text-[11px] font-mono px-2 py-1 border border-line text-muted hover:border-red-900 hover:text-red-400 transition-colors disabled:opacity-40"
              >
                remove
              </button>
            </div>

            {/* accent re-pick */}
            <div className="flex items-center gap-3 px-5 py-3 border-b border-line">
              <div className="flex gap-1.5">
                {theme.palette.ringStops.slice(0, 5).map((c, i) => (
                  <button
                    key={i}
                    onClick={() => pickAccent(i)}
                    title={i === activeIdx ? 'current accent' : 'use as accent'}
                    aria-label={i === activeIdx ? 'current accent' : 'set as accent'}
                    className={`w-5 h-5 rounded transition-transform hover:scale-110 ${i === activeIdx ? 'ring-2 ring-ink ring-offset-1 ring-offset-[#161616]' : ''}`}
                    style={{ background: c }}
                  />
                ))}
              </div>
              <span className="text-[11px] font-mono text-muted flex-1">tap a color to set accent</span>
            </div>

            {/* motion */}
            <div className="flex flex-col gap-2 px-5 py-3">
              <p className="text-[10px] font-mono text-muted uppercase tracking-wider">Motion</p>
              <div className="flex gap-2">
                {(theme.mediaType !== 'image' ? (['bloom', 'mesh', 'hue', 'live'] as const) : (['bloom', 'mesh', 'hue'] as const)).map((k) => {
                  const on = !!motion?.[k]
                  return (
                    <button
                      key={k}
                      onClick={() => commitMotion({ ...motion, [k]: !on } as ThemeMotion)}
                      className={`text-[11px] font-mono px-2.5 py-1 border transition-colors ${on ? 'border-accent/50 text-accent' : 'border-line text-muted hover:text-dim'}`}
                    >
                      {k}
                    </button>
                  )
                })}
              </div>
              {motion?.hue && (
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
                  <span className="text-[10px] font-mono text-dim w-9 text-right">{hueRange >= 360 ? 'full' : `${hueRange}°`}</span>
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
