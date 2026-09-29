import type { MachineCover } from './types'

const AR_URI = /^ar:\/\/[A-Za-z0-9_-]{43}$/
/** A thumbhash is ~25 bytes; base64 of it is well under this. */
const THUMBHASH = /^[A-Za-z0-9+/=_-]{8,120}$/

/** A cover as a request carries it, or null when it is not one: an `ar://`
 *  upload (the only kind the studio makes) and, optionally, its thumbhash. */
export function parseCover(raw: unknown): MachineCover | null {
  if (!raw || typeof raw !== 'object') return null
  const { uri, thumbhash } = raw as { uri?: unknown; thumbhash?: unknown }
  if (typeof uri !== 'string' || !AR_URI.test(uri)) return null
  if (thumbhash !== undefined && (typeof thumbhash !== 'string' || !THUMBHASH.test(thumbhash))) return null
  return { uri, ...(typeof thumbhash === 'string' ? { thumbhash } : {}) }
}
