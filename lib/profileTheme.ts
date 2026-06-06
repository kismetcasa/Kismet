import { redis } from './redis'
import { safeRead } from './redisRead'
import type { Palette, ThemeGeometry } from './colorExtract'

// One content-derived theme per profile, canonical-address-keyed (like
// lib/profile.ts). Read SSR on the profile page — the ONLY per-view cost is a
// single small GET, and it's parallelizable with the existing canonical
// resolve; feeds/search/other hot paths are untouched. Written rarely (an
// owner picking a theme moment).
//
// Types come from colorExtract via `import type`, so this module — and any
// client component that type-imports ProfileTheme — never pulls sharp into the
// bundle. Only server code (the page + the theme route) imports the runtime
// extractor.

// Owner-set ambient-motion prefs for the backdrop. All default OFF (absent =
// off). Necessary-but-not-sufficient: the animations only run when the VIEWER
// also allows motion (the keyframes live solely in a prefers-reduced-motion:
// no-preference query) and the header is on screen. transform/opacity effects
// (bloom, mesh) are GPU-cheap; hue is a filter, so it runs slow + in-view-gated.
export interface ThemeMotion {
  bloom?: boolean   // soft palette glow that breathes (opacity + scale)
  mesh?: boolean    // the seeded ambient mesh slowly drifts (transform)
  hue?: boolean     // the palette slowly shifts hue (filter)
  /** Hue sweep amplitude in degrees when `hue` is on. 360 = full continuous
   *  cycle; anything less oscillates ±range/2 around the true palette so the
   *  colors stay faithful to the artwork. Default 20. Only meaningful when
   *  `hue` is true. */
  hueRange?: number
  /** Play the moment's animated artwork (video/gif) as the backdrop instead of
   *  the blurred still. Opt-in, default off; only meaningful for an animated
   *  source (mediaType !== 'image'). The viewer's reduced-motion / data-saver
   *  still falls back to the still. */
  live?: boolean
}

export interface ProfileTheme {
  momentRef: string             // "collection:tokenId" the theme derives from
  momentName?: string           // source moment's name — for the provenance chip
  mediaType: 'image' | 'video' | 'gif'  // backdrop media: blurred still (V3) vs animated video/gif (V4)
  mediaUrl: string              // non-animated still (poster) — backdrop base + provenance chip
  animationUrl?: string         // video/gif src for the V4 backdrop
  thumbhash?: string            // instant SSR backdrop seed (no flash)
  palette: Palette
  geometry: ThemeGeometry
  motion?: ThemeMotion          // owner-set ambient motion (default: all off)
  updatedAt: number
}

const key = (address: string) => `kismetart:profile-theme:${address.toLowerCase()}`

export async function getProfileTheme(address: string): Promise<ProfileTheme | null> {
  return safeRead(
    'getProfileTheme',
    async () => {
      const raw = await redis.get<string | ProfileTheme>(key(address))
      if (!raw) return null
      return typeof raw === 'string' ? (JSON.parse(raw) as ProfileTheme) : raw
    },
    null,
  )
}

export async function setProfileTheme(address: string, theme: ProfileTheme): Promise<void> {
  await redis.set(key(address), JSON.stringify(theme))
}

export async function clearProfileTheme(address: string): Promise<void> {
  await redis.del(key(address))
}
