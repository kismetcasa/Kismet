/**
 * `<input type="datetime-local">` value helpers for the sale-window surfaces
 * (MintForm's inputs and the detail page's sale editor), hoisted so the two
 * can't drift on format or timezone semantics. datetime-local carries NO
 * timezone — values are the creator's local wall-clock, so both directions
 * go through the local-time Date accessors, never toISOString (which would
 * shift by the UTC offset). MintForm consumes toLocalInput today and keeps
 * its long-standing inline parse (pinned by verify-mint; migrating it buys
 * no behavior change); the editor consumes both helpers.
 */

/** Format a Date as a datetime-local input value (minute precision). */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Parse a datetime-local input value to unix seconds, or null when empty /
 * unparseable — callers surface their own field-specific error copy.
 */
export function parseLocalInputSec(value: string): number | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  if (Number.isNaN(ms)) return null
  return Math.floor(ms / 1000)
}
