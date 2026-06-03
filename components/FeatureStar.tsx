'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Star } from 'lucide-react'
import { useAdmin } from '@/contexts/AdminContext'

// Hold duration to promote a mint to a Mint Pass Display. Long + deliberate
// so a collection-scale showcase is never set by accident; the progress ring
// gives live feedback so the press never feels unresponsive. One knob.
const HOLD_MS = 3000
// A press released sooner than this counts as a tap (toggle small-feature).
// Between TAP_MAX and HOLD_MS is an aborted hold — a no-op, so letting go
// mid-ring doesn't accidentally feature the mint.
const TAP_MAX_MS = 400
// The brand gradient's violet stop — the Mint Pass Display signifier, distinct
// from the yellow "featured" state. This is an actual gradient color (not one
// of the retired purple tokens), so the hex-token lint rule allows it.
const DISPLAY_PURPLE = '#9692f6'
// Star glyph size and the progress-ring box around it. Fixed — every surface
// renders the star at the same size today.
const STAR_SIZE = 16
const RING_SIZE = STAR_SIZE + 12

interface FeatureStarProps {
  address: string
  tokenId: string
  /** Positioning / layout classes (e.g. an absolute image corner). */
  className?: string
}

/**
 * Admin/curator feature control rendered as a single star with two gestures:
 *   - tap            → toggle the small featured-grid tier (star = yellow)
 *   - hold (3s)      → toggle the Mint Pass Display tier  (star = purple)
 * The two tiers are mutually exclusive (enforced in AdminContext + the API),
 * so the star shows exactly one of: off (faint) · featured (yellow) · Mint
 * Pass Display (purple). Renders nothing for non-admins, so it adds no weight
 * to public feeds.
 */
export function FeatureStar({ address, tokenId, className = '' }: FeatureStarProps) {
  const { isAdmin, featuredKeys, mintPassKeys, toggleFeatured, toggleMintPassDisplay } = useAdmin()

  const [holding, setHolding] = useState(false)
  const holdTimer = useRef<number | null>(null)
  const pressStart = useRef(0)
  const didHold = useRef(false)

  const clearHold = useCallback(() => {
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
    setHolding(false)
  }, [])

  // Tear down a timer if the card unmounts mid-press (feeds unmount cards on
  // scroll), so the deferred toggle can't fire against a gone component.
  useEffect(() => () => {
    if (holdTimer.current !== null) clearTimeout(holdTimer.current)
  }, [])

  if (!isAdmin) return null

  const key = `${address.toLowerCase()}:${tokenId}`
  const isFeatured = featuredKeys.has(key)
  const isDisplay = mintPassKeys.has(key)

  const startHold = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Capture so a finger drifting off the small target during the 3s hold
    // doesn't cancel the gesture — pointerup/cancel still land here.
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
    didHold.current = false
    pressStart.current = Date.now()
    setHolding(true)
    holdTimer.current = window.setTimeout(() => {
      didHold.current = true
      holdTimer.current = null
      setHolding(false)
      try { navigator.vibrate?.(15) } catch {}
      toggleMintPassDisplay(address, tokenId)
    }, HOLD_MS)
  }

  const endHold = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const wasHold = didHold.current
    const elapsed = Date.now() - pressStart.current
    clearHold()
    if (wasHold) return // display toggle already fired on completion
    if (elapsed < TAP_MAX_MS) {
      // Tap toggles the featured tier. Unfeaturing a display cascades the
      // hero treatment off too (handled in toggleFeatured), so a tap on any
      // state resolves correctly without a special case here.
      toggleFeatured(address, tokenId)
    }
    // Between TAP_MAX_MS and HOLD_MS → aborted hold → intentional no-op.
  }

  const cancelHold = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    clearHold()
  }

  const title = isDisplay
    ? 'Mint Pass Display · tap to clear'
    : isFeatured
      ? 'Featured · tap to unfeature, hold to set Mint Pass Display'
      : 'Tap to feature · hold to set Mint Pass Display'

  return (
    <button
      type="button"
      onPointerDown={startHold}
      onPointerUp={endHold}
      onPointerCancel={cancelHold}
      onClick={(e) => { e.preventDefault(); e.stopPropagation() }}
      onContextMenu={(e) => e.preventDefault()}
      title={title}
      aria-label={title}
      className={`z-10 min-w-10 min-h-10 flex items-center justify-center transition-colors select-none touch-none ${
        isDisplay ? '' : isFeatured ? 'text-yellow-400' : 'text-faint hover:text-dim'
      } ${className}`}
      style={isDisplay ? { color: DISPLAY_PURPLE } : undefined}
    >
      <span className="relative flex items-center justify-center">
        {holding && (
          <svg
            aria-hidden
            className="absolute pointer-events-none -rotate-90"
            width={RING_SIZE}
            height={RING_SIZE}
            viewBox="0 0 100 100"
          >
            <circle cx="50" cy="50" r="46" fill="none" stroke={DISPLAY_PURPLE} strokeOpacity="0.25" strokeWidth="9" />
            <circle
              cx="50"
              cy="50"
              r="46"
              fill="none"
              stroke={DISPLAY_PURPLE}
              strokeWidth="9"
              strokeLinecap="round"
              pathLength={100}
              strokeDasharray="100"
              style={{ animation: `feature-hold ${HOLD_MS}ms linear forwards` }}
            />
          </svg>
        )}
        <Star size={STAR_SIZE} fill={isFeatured || isDisplay ? 'currentColor' : 'none'} strokeWidth={1.5} />
      </span>
    </button>
  )
}
