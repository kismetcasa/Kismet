'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { MomentImage } from './MomentImage'

/**
 * A cover image that can change in place — a cover picked on a card or a row
 * previewing where it will go, then the one saved. It remembers which image
 * failed, not a flag, so a new one is tried while the one that failed is not
 * fetched again. Each image also gets its own MomentImage (keyed by src): one
 * kept across a change would serve the new src through the old one's delivery
 * mode for a render (a picked blob: asked of the proxy), and where it skips
 * the direct walk (WebKit, in-app webviews) a proxy error gives up on the
 * image at once. `fallback` shows while there is no image, or after it failed.
 */
export function CoverImage({
  image,
  thumbhash,
  alt,
  sizes,
  priority,
  className,
  fallback,
}: {
  image: string | null | undefined
  thumbhash?: string
  alt: string
  sizes: string
  priority?: boolean
  className: string
  fallback: ReactNode
}) {
  const [failed, setFailed] = useState<string | null>(null)
  const src = image && image !== failed ? image : null
  if (!src) return <>{fallback}</>
  return (
    <MomentImage
      key={src}
      src={src}
      alt={alt}
      fill
      className={className}
      sizes={sizes}
      onAllError={() => setFailed(src)}
      priority={priority}
      preferProxy
      thumbhash={thumbhash}
    />
  )
}

/**
 * A card led by a square cover: a collection in the featured row's phone
 * scroller, a machine in the play list and on its creator's profile. The
 * cover links to `href` — or sits plain, for something with no page of its
 * own yet (a machine waiting for a curator); what sits under it is the
 * caller's.
 */
export function CoverCard({
  href,
  image,
  thumbhash,
  alt,
  sizes,
  priority,
  overlay,
  muted,
  children,
}: {
  href?: string
  image: string | null | undefined
  thumbhash?: string
  alt: string
  sizes: string
  priority?: boolean
  /** Drawn over the cover, inside its link (e.g. an admin toggle). */
  overlay?: ReactNode
  /** Quieter, for something that can no longer be had (a closed machine). */
  muted?: boolean
  children: ReactNode
}) {
  const coverClass = `relative aspect-square w-full block overflow-hidden bg-surface${muted ? ' grayscale opacity-60' : ''}`
  const cover = (
    <>
      {overlay}
      <CoverImage
        image={image}
        thumbhash={thumbhash}
        alt={alt}
        sizes={sizes}
        priority={priority}
        className="object-contain transition-transform duration-500 group-hover/img:scale-105"
        fallback={
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-line font-mono text-xs">no preview</span>
          </div>
        }
      />
    </>
  )
  return (
    <article className="flex flex-col bg-[#161616] border border-line overflow-hidden h-full">
      {href ? (
        <Link href={href} className={`${coverClass} group/img`}>
          {cover}
        </Link>
      ) : (
        <div className={coverClass}>{cover}</div>
      )}
      <div className="flex flex-col gap-2 p-3 flex-1">{children}</div>
    </article>
  )
}
