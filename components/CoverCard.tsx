'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { MomentImage } from './MomentImage'

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
  children: ReactNode
}) {
  // The image that failed, not a flag: a card whose image changes (a cover
  // picked on it previewing in place, then the one saved) shows the new one,
  // while the one that failed is not fetched again. Each image also gets its
  // own MomentImage (keyed below): one kept across a change would serve the
  // new src through the old one's delivery mode for a render (a picked blob:
  // asked of the proxy), and where it skips the direct walk (WebKit, in-app
  // webviews) a proxy error gives up on the image at once.
  const [failed, setFailed] = useState<string | null>(null)
  const src = image && image !== failed ? image : null
  const coverClass = 'relative aspect-square w-full block overflow-hidden bg-surface'
  const cover = (
    <>
      {overlay}
      {src ? (
        <MomentImage
          key={src}
          src={src}
          alt={alt}
          fill
          className="object-contain transition-transform duration-500 group-hover/img:scale-105"
          sizes={sizes}
          onAllError={() => setFailed(src)}
          priority={priority}
          preferProxy
          thumbhash={thumbhash}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <span className="text-line font-mono text-xs">no preview</span>
        </div>
      )}
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
