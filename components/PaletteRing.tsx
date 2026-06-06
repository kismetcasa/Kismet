'use client'

import type { ReactNode } from 'react'

interface PaletteRingProps {
  /** Palette colors swept around the ring (conic). Needs >=2 to render. */
  stops: string[]
  /** Seeded start angle so two profiles with close palettes still differ. */
  ringStart?: number
  /** Diameter of the wrapped avatar; ring thickness scales from it. */
  size: number
  children: ReactNode
}

// A conic-gradient ring around an avatar, painted from the profile's content
// palette — the signature identity element. Pure presentation: renders the
// child untouched when there's no usable palette, so it's safe to wrap any
// avatar unconditionally. Static for now; hue-cycling is a later motion toggle.
export function PaletteRing({ stops, ringStart = 0, size, children }: PaletteRingProps) {
  if (!Array.isArray(stops) || stops.length < 2) return <>{children}</>
  const ringWidth = Math.max(2, Math.round(size * 0.05))
  return (
    <div
      style={{
        display: 'inline-flex',
        borderRadius: '50%',
        padding: ringWidth,
        flexShrink: 0,
        background: `conic-gradient(from ${ringStart}deg, ${stops.join(', ')}, ${stops[0]})`,
      }}
    >
      {children}
    </div>
  )
}
