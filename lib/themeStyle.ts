import type { CSSProperties } from 'react'
import type { ProfileTheme } from './profileTheme'

// Client-safe and pure — no sharp, no redis. Builds the scoped CSS custom
// properties that re-skin a themed profile. The `import type` above keeps the
// server-only modules behind it (colorExtract→sharp, profileTheme→redis) out
// of any bundle that imports this helper.

const BRAND_TRIPLET = '255 135 206' // #ff87ce — matches the :root default

function hexToTriplet(hex: string): string {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = parseInt(full, 16)
  if (full.length !== 6 || Number.isNaN(n)) return BRAND_TRIPLET
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`
}

/**
 * Scoped CSS vars for a themed profile root. `--accent` overrides the
 * var-backed Tailwind token (re-skins every accent surface); `--accent-grad`
 * swaps the brand gradient for a palette sweep. Returns {} when there's no
 * theme so the brand default stands. Pure, so it runs identically at SSR (no
 * themed-vs-unthemed flash) and on the client. (The backdrop reads its colors
 * from the theme palette directly, not from vars.)
 */
export function themeCssVars(theme: ProfileTheme | null | undefined): CSSProperties {
  if (!theme) return {}
  const p = theme.palette
  return {
    '--accent': hexToTriplet(p.primary),
    '--accent-grad': `linear-gradient(to right, ${p.ringStops.join(', ')})`,
  } as CSSProperties
}
