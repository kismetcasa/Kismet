'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { MomentImage } from './MomentImage'
import type { Moment } from '@/lib/inprocess'

/**
 * The artist's own works, to pick from in the studios instead of pasting
 * addresses: the same list their profile shows (/api/timeline?creator=), so
 * what they see here is what they see there. A pasted artwork link still
 * works for anything else.
 */

export interface Work {
  collection: string
  tokenId: string
  name: string | null
  image: string | null
  mime?: string
  thumbhash?: string
}

export const workKey = (w: { collection: string; tokenId: string }) => `${w.collection.toLowerCase()}:${w.tokenId}`

/** The connected artist's works, newest first; null while loading. A hidden
 *  piece is left out: a machine never gives one. */
export function useMyWorks(address: string | undefined): Work[] | null {
  const [works, setWorks] = useState<Work[] | null>(null)
  useEffect(() => {
    if (!address) { setWorks(null); return }
    let live = true
    setWorks(null)
    fetch(`/api/timeline?creator=${address.toLowerCase()}&limit=100`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { moments?: Moment[] } | null) => {
        if (!live) return
        setWorks(
          (d?.moments ?? [])
            .filter((m) => !m.hidden && /^0x[0-9a-fA-F]{40}$/.test(m.address) && /^\d+$/.test(String(m.token_id)))
            .map((m) => ({
              collection: m.address.toLowerCase(),
              tokenId: String(m.token_id),
              name: m.metadata?.name?.trim() || null,
              image: m.metadata?.image ?? null,
              mime: m.metadata?.content?.mime,
              thumbhash: m.metadata?.kismet_thumbhash,
            })),
        )
      })
      .catch(() => { if (live) setWorks([]) })
    return () => { live = false }
  }, [address])
  return works
}

/** A piece's image as the studio shows it, beside its title — an empty
 *  square when it has none, the title saying what it is. */
export function WorkThumb({ work, size = 36 }: { work: Pick<Work, 'image' | 'mime' | 'thumbhash'>; size?: number }) {
  return (
    <span aria-hidden className="relative shrink-0 overflow-hidden border border-line bg-raised inline-block" style={{ width: size, height: size }}>
      {work.image && <MomentImage src={work.image} alt="" fill className="object-cover" sizes={`${size}px`} mime={work.mime} thumbhash={work.thumbhash} />}
    </span>
  )
}

/**
 * A grid of the artist's works behind one button. Each tile is a toggle:
 * picked tiles are marked, and picking one again puts it back.
 */
export function WorksPicker({
  works,
  picked,
  onPick,
  label,
  disabled,
}: {
  works: Work[] | null
  picked: ReadonlySet<string>
  onPick: (w: Work) => void
  label: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        disabled={disabled}
        className="self-start px-4 py-2 text-[10px] font-mono uppercase tracking-wider border border-line text-dim hover:text-ink disabled:opacity-40"
      >
        {label} {open ? '▲' : '▼'}
      </button>
      {open && (
        <div className="border border-line bg-[#0d0d0d] max-h-80 overflow-y-auto">
          {works === null ? (
            <p className="text-xs font-mono text-muted px-3 py-4">loading your works…</p>
          ) : works.length === 0 ? (
            <p className="text-xs font-mono text-muted px-3 py-4">
              nothing minted yet —{' '}
              <Link href="/mint" className="text-dim hover:text-ink underline">mint a piece</Link>
            </p>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-px bg-line">
              {works.map((w, i) => {
                const on = picked.has(workKey(w))
                const title = w.name ?? `#${w.tokenId}`
                return (
                  <button
                    key={workKey(w)}
                    type="button"
                    aria-pressed={on}
                    aria-label={title}
                    onClick={() => onPick(w)}
                    className={`relative aspect-square bg-surface overflow-hidden ${on ? 'ring-2 ring-inset ring-accent' : ''}`}
                  >
                    {w.image && (
                      <MomentImage src={w.image} alt="" fill className="object-cover" sizes="120px" priority={i < 6} mime={w.mime} thumbhash={w.thumbhash} />
                    )}
                    <span className="absolute inset-x-0 bottom-0 bg-black/70 px-1.5 py-1 text-left">
                      <span className="block text-[9px] font-mono text-ink truncate">{title}</span>
                    </span>
                    {on && <span className="absolute top-1 right-1 px-1 text-[9px] font-mono bg-accent text-black">✓</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
