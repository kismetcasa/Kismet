// Meta-description normalizer for artist-content-driven pages (artwork,
// collection). The description meta tag is fed by onchain metadata artists
// write — anywhere from two words to several paragraphs with newlines —
// while search engines want a single 25–160 char line (Bing flags anything
// outside that window as an Error; Google truncates around 160 and rewrites
// thin ones). Normalize whitespace, keep a too-short artist description by
// composing it with the page's fallback instead of discarding it, and clamp
// long ones at a word boundary.

const MIN = 25
const MAX = 160

export function metaDescription(
  raw: string | undefined | null,
  fallback: string,
): string {
  const normalized = (raw ?? '').replace(/\s+/g, ' ').trim()
  // Compose rather than discard a too-short artist description: "gm" alone
  // fails the window, but "gm — <fallback>" keeps the artist's words first.
  // Callers construct fallbacks that clear MIN on their own ("<name> —
  // artwork on Kismet, the onchain art platform on Base").
  const base =
    normalized.length >= MIN
      ? normalized
      : normalized
        ? `${normalized} — ${fallback}`
        : fallback
  if (base.length <= MAX) return base
  // Clamp at the last word boundary that fits alongside the ellipsis; a
  // single unbroken token past MIN falls back to a hard cut.
  const cut = base.slice(0, MAX - 1)
  const lastSpace = cut.lastIndexOf(' ')
  const atWord = lastSpace > MIN ? cut.slice(0, lastSpace) : cut
  return `${atWord.replace(/[\s,;:.–—-]+$/, '')}…`
}
