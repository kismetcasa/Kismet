/**
 * Generates an inline SVG `data:` URI for the `image` field of an
 * auto-deployed text-only collection's metadata. Without an image
 * field, marketplace + indexer cards render a broken-image icon;
 * inline SVG keeps the cover content-addressed without forcing a
 * separate Arweave upload and works on every viewer that supports
 * `data:` URIs in metadata (most do).
 */

const SVG_TEMPLATE_PREFIX = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600">'
const SVG_TEMPLATE_SUFFIX = '</svg>'

/** Escapes user-supplied text for safe inclusion in SVG. */
function escapeForSvg(text: string): string {
  const truncated = text.slice(0, 32)
  return truncated.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

/**
 * UTF-8-safe base64 encoder. Native `btoa` only accepts Latin-1; this
 * routes UTF-8 strings (emoji, non-ASCII names) through a Latin-1-safe
 * intermediate. Server-side, `Buffer` produces identical output.
 */
function utf8ToBase64(s: string): string {
  if (typeof window === 'undefined') {
    return Buffer.from(s, 'utf-8').toString('base64')
  }
  return btoa(unescape(encodeURIComponent(s)))
}

export function generateTextCollectionCoverDataUri(name: string): string {
  const safeName = escapeForSvg(name) || 'Untitled'
  const svg =
    SVG_TEMPLATE_PREFIX +
    '<rect width="600" height="600" fill="#0d0d0d"/>' +
    `<text x="300" y="296" text-anchor="middle" font-family="ui-monospace, monospace" font-size="36" fill="#efefef" font-weight="500">${safeName}</text>` +
    '<text x="300" y="340" text-anchor="middle" font-family="ui-monospace, monospace" font-size="14" fill="#ff87ce" letter-spacing="3">KISMET</text>' +
    SVG_TEMPLATE_SUFFIX
  return `data:image/svg+xml;base64,${utf8ToBase64(svg)}`
}
