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

/**
 * Patron Collection showcase — the bespoke single-artwork presentation for the
 * Kismet Patron Collection page, in the spirit of the featured Mint Pass
 * Display but pared down per the brief: the artwork alone (no frame, badges,
 * price, or flanking text) given a large full-width display, then a
 * "Patron Pass Description" panel beneath it.
 *
 * The artwork box hugs the image's own aspect ratio — sized from the thumbhash
 * up front and corrected to the natural ratio once the image loads — so the
 * image fills the column edge-to-edge with no crop and no letterbox. Clicking
 * it opens the moment, where the edition can be collected.
 */
export function PatronArtworkShowcase({ moment }: { moment: Moment }) {
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
    <div className="flex flex-col gap-6">
      {/* Artwork — just the image, no frame or overlays. The box matches the
          artwork's aspect ratio so object-contain fills it without cropping or
          letterboxing. Clicking opens the moment (where it can be collected). */}
      <Link
        href={momentHref}
        className="relative block w-full overflow-hidden"
        style={{ aspectRatio }}
      >
        {isVideo && media.src && !mediaError ? (
          <MomentVideo
            src={media.src}
            poster={media.poster}
            thumbhash={meta.kismet_thumbhash}
            showPosterLayer
            className="w-full h-full object-contain"
            priority
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
            priority
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

      {/* Patron Pass Description */}
      <div className="border border-line bg-[#0d0d0d] p-4 sm:p-5">
        <h3 className="text-xs font-mono text-muted uppercase tracking-widest mb-3">
          patron pass description
        </h3>
        <p className="text-sm font-mono text-dim leading-relaxed whitespace-pre-line">
          {PATRON_PASS_DESCRIPTION}
        </p>
      </div>
    </div>
  )
}
