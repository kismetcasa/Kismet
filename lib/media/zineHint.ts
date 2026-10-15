/**
 * A zine's `kismet_zine` metadata hint — the page count for badges and
 * discovery without fetching the PDF, and where the pages live. Its own
 * module, small: the media resolver, the server-side metadata types and the
 * OG route need the hint and nothing of the mint form behind lib/media/zineMedia.
 */

/** The page cap (ZINE_READER_DESIGN.md §7). */
export const ZINE_MAX_PAGES = 420

/** Who can read the pages: on Arweave for everyone, or in the private
 *  collector-file store for holders. */
export type ZineAccess = 'public' | 'collectors'

export interface ZineHint {
  pages: number
  access: ZineAccess
}

/** Validate a `kismet_zine` value read from metadata (anyone can write
 *  token JSON; a hint is only ever trusted as far as a badge). */
export function readZineHint(value: unknown): ZineHint | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as { pages?: unknown; access?: unknown }
  // Bounded by the cap: a hand-written token must not badge "99999999 pages".
  if (typeof v.pages !== 'number' || !Number.isInteger(v.pages) || v.pages < 1 || v.pages > ZINE_MAX_PAGES) return undefined
  if (v.access !== 'public' && v.access !== 'collectors') return undefined
  return { pages: v.pages, access: v.access }
}
