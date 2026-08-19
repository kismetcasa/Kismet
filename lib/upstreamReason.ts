// Distil an upstream error body into one short, user-safe reason. Pure and
// import-free so scripts/verify-distribute.ts can pin it without pulling in
// next/server — it guards a known leak regression (`1bf7b1b`), so its
// behaviour needs a test, not just a comment.

// Everything that could carry server topology out to a client: absolute URLs,
// bare hostnames, and file paths. Stripped below — `1bf7b1b` closed
// /api/distribute's 502 leaking the raw upstream body, and that must stay
// true even now that a reason is surfaced.
// Ordered: absolute URL, then filesystem path (no \b — the char before a
// leading '/' is usually a space, which is not a word boundary), then bare
// host:port/path. The host alternative demands an alphabetic ≥2-char final
// label so a decimal amount ("0.5 ETH") isn't mistaken for a hostname.
const TOPOLOGY_RE =
  /(?:https?:\/\/\S+|\/(?:home|var|usr|opt|app|tmp|root|srv)\/\S*|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?(?:\/\S*)?)/gi
const UPSTREAM_REASON_MAX = 140
// Keys upstream error envelopes actually use, most-specific first. Order
// validated against in_process_api's distribute failure envelope
// ({ status: 'error', message: '<generic sentence>', error: '<detail>' }):
// `error` carries the actionable detail there, `message` the boilerplate.
const REASON_KEYS = ['error', 'message', 'detail', 'details', 'reason', 'description']

/**
 * Distil an upstream error body into ONE short, human-readable reason safe to
 * show a user — or `''` when the body carries no usable signal (an HTML error
 * page, an empty body, a stack dump).
 *
 * Why surface anything at all: a bare "upstream error" toast is unactionable
 * for the artist AND for support, so a failed payout can only be diagnosed by
 * pulling server logs. Why sanitize: the raw body embeds the upstream URL and
 * topology, and lets a caller use error text as a status oracle. So we take a
 * known message field (never the whole body), strip URLs/hosts/paths, collapse
 * whitespace, and hard-cap the length.
 */
export function upstreamReason(body: string): string {
  const raw = pickReasonText(body)
  if (!raw) return ''
  const cleaned = raw
    .replace(TOPOLOGY_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length < 3) return ''
  return cleaned.length > UPSTREAM_REASON_MAX
    ? `${cleaned.slice(0, UPSTREAM_REASON_MAX - 1)}…`
    : cleaned
}

function pickReasonText(body: string): string {
  const text = body.trim()
  if (!text) return ''
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'string') return parsed
    if (parsed && typeof parsed === 'object') {
      for (const key of REASON_KEYS) {
        const v = (parsed as Record<string, unknown>)[key]
        if (typeof v === 'string' && v.trim()) return v
        // Nested envelope: { error: { message: "…" } }
        if (v && typeof v === 'object') {
          const nested = (v as Record<string, unknown>).message
          if (typeof nested === 'string' && nested.trim()) return nested
        }
      }
    }
    return ''
  } catch {
    // Not JSON. An HTML error page or a stack dump is noise, not a reason —
    // only a short plain-text body says anything useful.
    if (/^\s*</.test(text) || text.includes('\n    at ')) return ''
    return text.length <= 300 ? text : ''
  }
}
