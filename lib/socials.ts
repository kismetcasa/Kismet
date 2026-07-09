import { isSafePublicHttpsUrl } from './safeUrl'

/**
 * Social links on a profile. Best practice for a public creator profile is a
 * CURATED set of known platforms storing the HANDLE (not a raw URL) plus one
 * genuine free-URL field (`website`). Storing handles — and rebuilding the
 * outbound URL ourselves at render — means the link host is fixed by us, so an
 * attacker can't smuggle `javascript:`/`data:`/phishing hosts into an href, and
 * we validate against a tight per-platform charset instead of parsing arbitrary
 * URLs. `website` is the one field that IS a URL, so it goes through the same
 * https-only host guard the avatar uses.
 *
 * These links are user-CLAIMED, not proven. The one exception is X, which we
 * can inherit as VERIFIED from a user's Farcaster connected accounts (see
 * verifiedTwitter in lib/farcasterProfile.ts) — that always wins over a manual
 * `x` handle in the UI and carries a verified badge.
 */
export type SocialPlatformKey = 'x' | 'farcaster' | 'instagram' | 'website'

export interface ProfileSocials {
  x?: string
  farcaster?: string
  instagram?: string
  website?: string
}

export interface SocialPlatformDef {
  key: SocialPlatformKey
  /** Full name — used for aria-label / title. */
  label: string
  /** Compact tag shown in the profile's link row (mono aesthetic). */
  short: string
  /** Input placeholder shown in the edit form. */
  placeholder: string
  /** Normalize raw user input to the stored value, or null if invalid. */
  normalize(raw: string): string | null
  /** Outbound URL for a stored value. */
  url(value: string): string
  /** Human-readable display text for a stored value. */
  display(value: string): string
}

/**
 * Pull a bare handle out of whatever the user pasted — `@name`, `name`, a full
 * `https://x.com/name` URL, or a scheme-less `x.com/name`. Only strips the host
 * when it's one of the platform's known hosts; otherwise the raw string is
 * returned untouched and left to fail the handle regex.
 */
function extractHandle(raw: string, hosts: string[]): string {
  const s = raw.trim().replace(/^@+/, '')
  const asUrl = /^https?:\/\//i.test(s)
    ? s
    : /^[\w.-]+\.[a-z]{2,}\//i.test(s)
      ? `https://${s}`
      : null
  if (asUrl) {
    try {
      const u = new URL(asUrl)
      const host = u.hostname.replace(/^www\./i, '').toLowerCase()
      if (hosts.includes(host)) {
        const seg = u.pathname.split('/').filter(Boolean)[0]
        if (seg) return seg.replace(/^@+/, '')
      }
    } catch {
      // fall through — treat as a plain handle
    }
  }
  return s
}

function handlePlatform(
  key: SocialPlatformKey,
  label: string,
  short: string,
  hosts: string[],
  handleRe: RegExp,
  placeholder: string,
  // Lowercase before validating — for platforms whose handles are canonically
  // lowercase (Farcaster). X/Instagram preserve entered case.
  lower = false,
): SocialPlatformDef {
  return {
    key,
    label,
    short,
    placeholder,
    normalize(raw) {
      const extracted = extractHandle(raw, hosts)
      const h = lower ? extracted.toLowerCase() : extracted
      return handleRe.test(h) ? h : null
    },
    url(value) {
      return `https://${hosts[0]}/${value}`
    },
    display(value) {
      return `@${value}`
    },
  }
}

// Order here is the display + form order.
export const SOCIAL_PLATFORMS: SocialPlatformDef[] = [
  handlePlatform('x', 'X', 'x', ['x.com', 'twitter.com'], /^[A-Za-z0-9_]{1,15}$/, '@handle or x.com/…'),
  // Farcaster: fname or onchain ENS name. Real rule — label is <=16 chars of
  // lowercase [a-z0-9-], optionally suffixed `.eth` (onchain names only).
  handlePlatform(
    'farcaster',
    'Farcaster',
    'fc',
    ['farcaster.xyz', 'warpcast.com'],
    /^[a-z0-9][a-z0-9-]{0,15}(?:\.eth)?$/,
    '@handle or farcaster.xyz/…',
    true,
  ),
  handlePlatform('instagram', 'Instagram', 'ig', ['instagram.com'], /^[A-Za-z0-9._]{1,30}$/, '@handle or instagram.com/…'),
  {
    key: 'website',
    label: 'Website',
    short: 'web',
    placeholder: 'https://your-site.com',
    normalize(raw) {
      let s = raw.trim()
      // Reject path-only / protocol-relative input (`/x`, `//evil.com`): a
      // website is `scheme://host…` or `host…`, never leading-slash. Also stops
      // `//host` from being mangled into `https:////host`.
      if (!s || s.startsWith('/')) return null
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`
      if (!isSafePublicHttpsUrl(s)) return null
      // Reject embedded credentials (https://trusted.com@evil.com): the real
      // host is evil.com, so userinfo exists only to deceive. isSafePublicHttpsUrl
      // already parsed s, so this re-parse won't throw — the catch is belt-only.
      try {
        const u = new URL(s)
        if (u.username || u.password) return null
      } catch {
        return null
      }
      return s
    },
    url(value) {
      return value
    },
    display(value) {
      try {
        return new URL(value).hostname.replace(/^www\./i, '')
      } catch {
        return value
      }
    },
  },
]

const BY_KEY: Record<string, SocialPlatformDef> = Object.fromEntries(
  SOCIAL_PLATFORMS.map((p) => [p.key, p]),
)

/**
 * Resolve a stored (or inherited) social value into a safe outbound link.
 * Re-normalizes at render so a legacy/hand-edited row can never reach an href
 * without passing the same validation the write path enforced — returns null
 * (render nothing) if it doesn't.
 */
export function socialLink(
  key: string,
  value: string,
): { url: string; display: string; label: string; short: string } | null {
  const def = BY_KEY[key]
  if (!def || typeof value !== 'string' || !value) return null
  const normalized = def.normalize(value)
  if (normalized == null) return null
  return { url: def.url(normalized), display: def.display(normalized), label: def.label, short: def.short }
}

/**
 * Validate + normalize a submitted socials object. Empty/whitespace fields are
 * treated as "cleared" and dropped; a non-empty field that fails its platform
 * rule is a hard error (surfaced to the user), matching how the route rejects a
 * bad avatarUrl rather than silently swallowing a typo. Unknown keys are
 * ignored. The fixed 4-field shape inherently caps count/size.
 */
export function normalizeSocials(input: unknown): { socials: ProfileSocials } | { error: string } {
  if (input == null) return { socials: {} }
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'socials must be an object' }
  const src = input as Record<string, unknown>
  const out: ProfileSocials = {}
  for (const p of SOCIAL_PLATFORMS) {
    const raw = src[p.key]
    if (raw == null) continue
    if (typeof raw !== 'string') return { error: `${p.label} must be text` }
    const trimmed = raw.trim()
    if (!trimmed) continue // cleared
    const normalized = p.normalize(trimmed)
    if (normalized == null) return { error: `Invalid ${p.label} handle or URL` }
    out[p.key] = normalized
  }
  return { socials: out }
}
