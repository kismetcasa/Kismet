'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'

interface LazyMountProps {
  /** Render-prop: only invoked once the placeholder enters the IO window.
   *  Use a render-prop (not children prop) so any expensive JSX construction
   *  by the parent is also deferred — passing `<HeavyComponent/>` as children
   *  would build the element on every render of LazyMount regardless. */
  children: () => ReactNode
  /** Distance from the viewport at which to start mounting. 200px gives the
   *  browser time to fetch/decode images before the card scrolls into the
   *  visible area, avoiding pop-in on normal scroll. */
  rootMargin?: string
  /** Placeholder className, applied to the reservation div before mount. */
  placeholderClassName?: string
  /** Placeholder content. Default mimics a feed-card shape (square image
   *  area + small footer) so layout shift is near-zero when the real card
   *  swaps in. */
  placeholder?: ReactNode
}

const DEFAULT_PLACEHOLDER = (
  <>
    <div className="aspect-square bg-raised" />
    <div className="p-4 space-y-2 h-20">
      <div className="h-3 w-2/3 bg-raised rounded" />
      <div className="h-3 w-1/3 bg-raised rounded" />
    </div>
  </>
)

/**
 * Mount the wrapped content only when the placeholder enters (or nears)
 * the viewport. Once mounted, content stays mounted — this is
 * mount-deferral, not virtualization-with-unmount (avoids the
 * SharedVideoProvider race where a video's slot unmounts mid-grace).
 *
 * NEVER instantiated on desktop: the only caller (PaginatedGrid) gates
 * its use on a `lazy` prop that the discover page sets to `false` on
 * desktop UAs. Server-side UA detection means the decision is baked
 * into the SSR HTML — no client-side flip, no hydration window where
 * desktop briefly sees the lazy tree.
 */
export function LazyMount({
  children,
  rootMargin = '200px',
  placeholderClassName,
  placeholder = DEFAULT_PLACEHOLDER,
}: LazyMountProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    if (mounted) return
    const node = ref.current
    if (!node) return

    // Single-shot observer — disconnect on first intersection so we
    // don't keep observing once content has mounted.
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setMounted(true)
          observer.disconnect()
        }
      },
      { rootMargin },
    )

    observer.observe(node)
    return () => observer.disconnect()
  }, [mounted, rootMargin])

  if (mounted) {
    return <>{children()}</>
  }

  return (
    <div
      ref={ref}
      className={placeholderClassName ?? 'bg-[#161616] border border-line overflow-hidden'}
      aria-hidden
    >
      {placeholder}
    </div>
  )
}
