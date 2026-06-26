'use client'

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { type Moment } from '@/lib/inprocess'
import { resolveMomentMedia } from '@/lib/media/resolveMomentMedia'
import { thumbhashToBlurDataURL, thumbhashToRatio } from '@/lib/media/thumbhash'
import { MomentImage } from './MomentImage'
import { MomentVideo } from './MomentVideo'
import { PATRON_PASS_DESCRIPTION } from '@/lib/patronCollection'

// Pre-load guess until the thumbhash (then the loaded image) reports the real
// shape — mirrors the Mint Pass Display so the box never letterboxes.
const DEFAULT_RATIO = 1.5
const MIN_RATIO = 0.2
const MAX_RATIO = 5
const clampRatio = (r: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, r))
// Cap the artwork's rendered HEIGHT so portrait/tall pieces don't tower off the
// screen. Applied as a max-WIDTH of (cap × ratio): a wide/landscape piece's cap
// exceeds the column so it just fills the width (height stays well under the
// cap, unchanged from before); a portrait piece is capped at this height and
// centered. `min(80vh, …)` keeps it inside the viewport on any device; the px
// ceiling stops it dominating huge monitors.
const MAX_ART_HEIGHT = 'min(80vh, 760px)'

/**
 * One Patron artwork — the image alone (no frame, badges, price, or text),
 * given a large display. The box hugs the image's own aspect ratio (sized from
 * the thumbhash up front, corrected to the natural ratio on load) so there's no
 * crop and no letterbox; the height cap keeps portrait pieces from towering.
 * Clicking opens the moment, where the edition can be collected.
 */
function PatronArtwork({ moment, priority }: { moment: Moment; priority?: boolean }) {
  const [naturalRatio, setNaturalRatio] = useState<number | null>(null)
  const [mediaError, setMediaError] = useState(false)

  const meta = moment.metadata ?? {}
  const media = resolveMomentMedia(meta)
  const isVideo = media.kind === 'video'
  const blurPreview = useMemo(
    () => thumbhashToBlurDataURL(meta.kismet_thumbhash),
    [meta.kismet_thumbhash],
  )
  const thumbRatio = useMemo(
    () => thumbhashToRatio(meta.kismet_thumbhash),
    [meta.kismet_thumbhash],
  )
  const aspectRatio = clampRatio(naturalRatio ?? thumbRatio ?? DEFAULT_RATIO)
  const handleNaturalSize = useCallback((w: number, h: number) => {
    if (w > 0 && h > 0) setNaturalRatio(w / h)
  }, [])

  const title = meta.name ?? `#${moment.token_id}`
  const momentHref = `/moment/${moment.address}/${moment.token_id}`

  return (
    // `mx-auto` centers a height-capped portrait in the column (its used width
    // < 100% via max-width); a full-width landscape is unaffected. Plain block
    // centering avoids the flex `align-items: stretch` vs aspect-ratio gotcha.
    <Link
      href={momentHref}
      className="relative block w-full mx-auto overflow-hidden"
      style={{ aspectRatio, maxWidth: `calc(${MAX_ART_HEIGHT} * ${aspectRatio})` }}
    >
      {isVideo && media.src && !mediaError ? (
        <MomentVideo
          src={media.src}
          poster={media.poster}
          thumbhash={meta.kismet_thumbhash}
          showPosterLayer
          className="w-full h-full object-contain"
          priority={priority}
          onAllError={() => setMediaError(true)}
        />
      ) : (media.kind === 'image' || media.kind === 'gif') && media.src && !mediaError ? (
        <MomentImage
          src={media.src}
          alt={title}
          fill
          className="object-contain"
          sizes="(max-width: 896px) 100vw, 896px"
          mime={media.kind === 'gif' ? 'image/gif' : meta.content?.mime}
          thumbhash={meta.kismet_thumbhash}
          priority={priority}
          onNaturalSize={handleNaturalSize}
          onAllError={() => setMediaError(true)}
        />
      ) : blurPreview ? (
        <span
          aria-hidden
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: `url(${blurPreview})` }}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-surface">
          <span className="text-line font-mono text-xs">no preview</span>
        </div>
      )}
    </Link>
  )
}

/**
 * Patron Collection showcase — the bespoke presentation for the Kismet Patron
 * Collection page: every artwork gets the same large borderless display (the
 * standard for this collection, so there's no per-moment discrepancy), followed
 * once by the "Patron Pass Description" panel. Only the first artwork loads
 * eagerly (the LCP); the rest are lazy.
 */
export function PatronArtworkShowcase({ moments }: { moments: Moment[] }) {
  return (
    <div className="flex flex-col gap-6">
      {moments.map((m, i) => (
        <PatronArtwork
          key={m.id || `${m.address}-${m.token_id}`}
          moment={m}
          priority={i === 0}
        />
      ))}

      {/* Patron Pass Description */}
      <div className="border border-line bg-[#0d0d0d] p-4 sm:p-5">
        <h3 className="text-xs font-mono text-muted uppercase tracking-widest mb-3">
          patron pass description
        </h3>
        <p className="text-sm font-mono text-dim leading-relaxed whitespace-pre-line">
          {PATRON_PASS_DESCRIPTION.split('Kismet Casa')[0]}
          <a
            href="https://kismetcasa.xyz"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-ink transition-colors"
          >
            Kismet Casa
          </a>
          {PATRON_PASS_DESCRIPTION.split('Kismet Casa')[1]}
        </p>
      </div>
    </div>
  )
}
