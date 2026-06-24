'use client'

import { useEffect, useState } from 'react'
import { ScrollText } from 'lucide-react'
import type { Moment } from '@/lib/inprocess'
import {
  PATRON_COLLECTION_ADDRESS,
  PATRON_TITLE,
  PATRON_TAGLINE,
  PATRON_ARTWORK_DESCRIPTIONS,
} from '@/lib/patron'
import { PatronArtwork } from './PatronArtwork'
import { MintAccessRulesModal } from './MintAccessRulesModal'

/**
 * The Patron Collection page (/patron). Renders each artwork in the gate's
 * pass collection as a big horizontal display (PatronArtwork) with its
 * description beneath, and a top-right "Mint Access Rules" button that opens
 * the informational modal. Moments are fetched client-side from the same
 * /api/timeline route the collection page uses.
 */
export function PatronCollection() {
  const [moments, setMoments] = useState<Moment[] | null>(null)
  const [rulesOpen, setRulesOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/timeline?collection=${PATRON_COLLECTION_ADDRESS}&limit=50`)
      .then((r) => (r.ok ? r.json() : { moments: [] }))
      .then((d) => {
        if (!cancelled) setMoments(Array.isArray(d.moments) ? d.moments : [])
      })
      .catch(() => {
        if (!cancelled) setMoments([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="max-w-5xl mx-auto px-4 py-10">
      {/* Header — title + tagline on the left, Mint Access Rules top right. */}
      <div className="flex items-start justify-between gap-4 mb-10">
        <div className="flex flex-col gap-2 min-w-0">
          <h1 className="text-lg sm:text-xl font-mono text-ink">{PATRON_TITLE}</h1>
          <p className="text-xs font-mono text-dim leading-relaxed max-w-xl">
            {PATRON_TAGLINE}
          </p>
        </div>
        <button
          onClick={() => setRulesOpen(true)}
          className="flex-shrink-0 inline-flex items-center gap-1.5 whitespace-nowrap border border-line hover:border-muted px-3 py-2 text-[10px] sm:text-xs font-mono uppercase tracking-widest text-dim hover:text-ink transition-colors"
        >
          <ScrollText size={13} />
          Mint Access Rules
        </button>
      </div>

      {/* Artworks — one big horizontal display per piece. */}
      {moments === null ? (
        <div className="flex flex-col gap-14">
          {[0, 1].map((i) => (
            <div key={i} className="w-full aspect-[3/2] bg-surface border border-line animate-pulse" />
          ))}
        </div>
      ) : moments.length === 0 ? (
        <p className="text-xs font-mono text-muted">no artworks in this collection yet</p>
      ) : (
        <div className="flex flex-col gap-14">
          {moments.map((m, i) => (
            <PatronArtwork
              key={m.id || `${m.address}-${m.token_id}`}
              moment={m}
              description={PATRON_ARTWORK_DESCRIPTIONS[m.token_id]}
              priority={i === 0}
            />
          ))}
        </div>
      )}

      {rulesOpen && <MintAccessRulesModal onClose={() => setRulesOpen(false)} />}
    </div>
  )
}
