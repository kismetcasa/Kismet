'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { shortAddress, type MomentDetail } from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { fetchCollectionChip } from '@/lib/collectionCache'
import { useTextContent } from '@/lib/textCache'
import { resolveMomentMedia } from '@/lib/media/resolveMomentMedia'
import { thumbhashToBlurDataURL } from '@/lib/media/thumbhash'
import { MomentImage } from './MomentImage'
import { MomentVideo } from './MomentVideo'
import { ProfileAvatar } from './ProfileAvatar'

interface FeaturedMomentProps {
  address: string
  tokenId: string
  /**
   * Above-the-fold hint. The showcase leads the featured tab (the default
   * landing tab), so its artwork is the LCP candidate — forwarded to
   * MomentImage/MomentVideo so it loads eagerly instead of behind hydration.
   */
  priority?: boolean
}

// Outer shell mirrors CollectionRow's: a full-width bordered surface that
// stacks on mobile and splits artwork-left / details-right on desktop, so
// the single-moment hero reads at the same scale as a featured collection
// row in the same feed.
const SHELL =
  'flex flex-col lg:flex-row border border-line bg-[#161616] overflow-hidden'
// Artwork panel. Square at every breakpoint (object-contain letterboxes any
// aspect so the whole piece is always visible — "fit properly"). Full-width
// on mobile; a fixed, generous square on lg+ that drives the row height to
// roughly match a CollectionRow. lg:flex-shrink-0 stops the flex row from
// squeezing it when the description runs long.
const ARTWORK =
  'group relative aspect-square w-full lg:w-[30rem] xl:w-[34rem] lg:flex-shrink-0 bg-surface overflow-hidden block'

/**
 * Single-moment hero for the featured tab. Showcases one artwork at the
 * same footprint as the collection display (CollectionRow) beside it:
 * a large object-contain artwork panel with the moment's identity
 * (title, creator, collection, description) alongside.
 *
 * Self-contained — fetches its own MomentDetail and resolves the creator /
 * collection chips from the shared caches MomentCard already uses, so
 * wiring it in is a single render with no new data plumbing. Renders
 * nothing if the moment fails to load or is hidden, so a bad reference
 * never leaves a broken hero atop the feed.
 *
 * Deliberately button-free for now: this is the display-card-first pass.
 * The collect / curation affordances are a follow-up.
 */
export function FeaturedMoment({ address, tokenId, priority }: FeaturedMomentProps) {
  const [detail, setDetail] = useState<MomentDetail | null>(null)
  const [failed, setFailed] = useState(false)
  const [imgError, setImgError] = useState(false)
  const [videoError, setVideoError] = useState(false)
  const [collectionImageFailed, setCollectionImageFailed] = useState(false)

  const [creatorName, setCreatorName] = useState<string | null>(null)
  const [creatorAvatar, setCreatorAvatar] = useState<string | undefined>(undefined)
  const [collectionName, setCollectionName] = useState<string | null>(null)
  const [collectionImage, setCollectionImage] = useState<string | null>(null)

  // Fetch the moment once. /api/moment stitches `hidden` + `creator` (the
  // timeline-resolved minter, not momentAdmins[0]) onto the inprocess body —
  // the same canonical path MomentCard/MomentDetailView use.
  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams({
      collectionAddress: address,
      tokenId,
      chainId: '8453',
    })
    fetch(`/api/moment?${params}`)
      .then((r) => (r.ok ? (r.json() as Promise<MomentDetail>) : Promise.reject()))
      .then((d) => { if (!cancelled) setDetail(d) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [address, tokenId])

  // Resolve the creator's display name + avatar once the address is known.
  // Seed with the inprocess username / shortAddress so we never flash a raw
  // address, then upgrade from the Kismet profile cache (same logic as
  // MomentCard).
  const creatorAddress = detail?.creator?.address
  const creatorUsername = detail?.creator?.username
  useEffect(() => {
    if (!creatorAddress) return
    setCreatorName(creatorUsername || shortAddress(creatorAddress))
    fetchCreatorProfile(creatorAddress)
      .then(({ name, avatarUrl }) => {
        const resolved = !!name && name !== shortAddress(creatorAddress)
        if (resolved) setCreatorName(name)
        setCreatorAvatar(avatarUrl)
      })
      .catch(() => {})
  }, [creatorAddress, creatorUsername])

  // Kismet collection chip — name resolves to null for non-platform /
  // unknown contracts, in which case the chip stays hidden.
  useEffect(() => {
    fetchCollectionChip(address)
      .then(({ name, image }) => {
        setCollectionName(name)
        setCollectionImage(image)
      })
      .catch(() => {})
  }, [address])

  const meta = detail?.metadata ?? {}
  const media = resolveMomentMedia(meta)
  const isVideo = media.kind === 'video'
  const isTextMoment = media.kind === 'text'
  const blurPreview = useMemo(
    () => thumbhashToBlurDataURL(meta.kismet_thumbhash),
    [meta.kismet_thumbhash],
  )
  const textSnippet = useTextContent(isTextMoment ? meta.content?.uri : undefined)

  // A failed load or a hidden moment collapses the hero rather than leaving
  // a broken/locked tile at the top of the feed.
  if (failed || detail?.hidden) return null
  const loading = !detail

  const momentHref = `/moment/${address}/${tokenId}`

  return (
    <article className={SHELL}>
      {/* Artwork — links to the detail overlay (same intercepting-route
          behaviour as MomentCard). */}
      <Link href={momentHref} className={ARTWORK} aria-label={meta.name ?? `moment #${tokenId}`}>
        {isVideo && media.src && !videoError ? (
          <MomentVideo
            src={media.src}
            poster={media.poster}
            thumbhash={meta.kismet_thumbhash}
            showPosterLayer
            className="w-full h-full object-contain"
            priority={priority}
            onAllError={() => setVideoError(true)}
          />
        ) : (media.kind === 'image' || media.kind === 'gif') && media.src && !imgError ? (
          <MomentImage
            src={media.src}
            alt={meta.name ?? 'moment'}
            fill
            className="object-contain transition-transform duration-500 group-hover:scale-105"
            sizes="(max-width: 1024px) 100vw, 34rem"
            // Force the gif mime so the optimizer is skipped and animated
            // bytes stream through /api/img.
            mime={media.kind === 'gif' ? 'image/gif' : meta.content?.mime}
            thumbhash={meta.kismet_thumbhash}
            priority={priority}
            preferProxy
            onAllError={() => setImgError(true)}
          />
        ) : isTextMoment ? (
          <div className="w-full h-full flex flex-col p-6 sm:p-10 bg-gradient-to-br from-raised to-surface overflow-hidden">
            <span className="text-[10px] font-mono text-muted uppercase tracking-widest mb-3">
              writing
            </span>
            {meta.name && (
              <p className="text-base sm:text-lg font-mono text-ink mb-3 truncate">{meta.name}</p>
            )}
            {textSnippet && (
              <p className="text-sm font-mono text-[#bbb] leading-relaxed whitespace-pre-wrap">
                {textSnippet}
              </p>
            )}
            {!meta.name && !textSnippet && (
              <p className="text-sm font-mono text-[#bbb]">untitled</p>
            )}
          </div>
        ) : blurPreview ? (
          <span
            aria-hidden
            className="absolute inset-0 bg-cover bg-center"
            style={{ backgroundImage: `url(${blurPreview})` }}
          />
        ) : loading ? (
          <span aria-hidden className="absolute inset-0 bg-accent/10 animate-pulse" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-line font-mono text-xs">no preview</span>
          </div>
        )}
      </Link>

      {/* Details — vertically centred so the hero reads as composed rather
          than top-loaded, with breathing room befitting a showcase. */}
      <div className="flex flex-col justify-center gap-3 p-6 sm:p-8 lg:p-10 lg:flex-1 min-w-0">
        <span className="text-[10px] font-mono uppercase tracking-[0.2em] accent-grad w-fit">
          featured
        </span>

        {loading ? (
          <div className="flex flex-col gap-3" aria-hidden>
            <span className="h-6 w-2/3 bg-line/60 animate-pulse" />
            <span className="h-3 w-1/3 bg-line/40 animate-pulse" />
            <span className="h-3 w-full bg-line/30 animate-pulse mt-2" />
            <span className="h-3 w-5/6 bg-line/30 animate-pulse" />
          </div>
        ) : (
          <>
            <Link href={momentHref} className="w-fit max-w-full">
              <h2 className="text-xl lg:text-2xl font-mono text-ink leading-snug hover:text-dim transition-colors break-words">
                {meta.name ?? `#${tokenId}`}
              </h2>
            </Link>

            {creatorAddress && creatorName && (
              <Link
                href={`/profile/${creatorAddress}`}
                className="flex items-center gap-2 group/creator w-fit max-w-full"
                title={creatorAddress}
              >
                <ProfileAvatar address={creatorAddress} avatarUrl={creatorAvatar} size={22} />
                <span className="text-xs sm:text-sm font-mono text-muted group-hover/creator:text-dim transition-colors truncate min-w-0">
                  {creatorName}
                </span>
              </Link>
            )}

            {collectionName && (
              <Link
                href={`/collection/${address}`}
                className="flex items-center gap-1.5 group/collection w-fit max-w-full"
                title={collectionName}
              >
                {collectionImage && !collectionImageFailed && (
                  <div className="w-4 h-4 relative flex-shrink-0 bg-raised overflow-hidden">
                    <MomentImage
                      src={collectionImage}
                      alt=""
                      fill
                      className="object-cover"
                      sizes="16px"
                      onAllError={() => setCollectionImageFailed(true)}
                    />
                  </div>
                )}
                <span className="text-xs font-mono text-muted group-hover/collection:text-dim transition-colors truncate min-w-0">
                  {collectionName}
                </span>
              </Link>
            )}

            {meta.description && (
              <p className="text-sm sm:text-base font-mono text-dim leading-relaxed whitespace-pre-wrap line-clamp-5 lg:line-clamp-6 mt-1">
                {meta.description}
              </p>
            )}
          </>
        )}
      </div>
    </article>
  )
}
