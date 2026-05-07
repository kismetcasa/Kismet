/**
 * Generates an inline SVG `data:` URI to use as the collection cover
 * when a user auto-deploys a text-only collection (Phase 2 first-mint
 * UX). Without this, the collection metadata's `image` field would be
 * empty and many marketplace + indexer surfaces fall back to a
 * broken-image icon — bad first impression on a brand-new collection.
 *
 * Inline SVG is the right tool here because:
 *   - No Arweave upload step (text-mode users skip media entirely;
 *     adding a forced upload would hurt the UX we're optimizing)
 *   - No env config or pre-uploaded asset for operators to manage
 *   - Permanent (data URIs are content-addressed by their bytes)
 *   - Most indexers (inprocess, OpenSea, Zora) support data: URIs in
 *     ERC-1155 metadata.image
 *
 * The cover renders the collection name on Kismet's dark background
 * with the standard mono font. Future improvements (artist avatar,
 * gradient, etc.) can drop in here without changing the call sites.
 */

const SVG_TEMPLATE_PREFIX = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600">'
const SVG_TEMPLATE_SUFFIX = '</svg>'

/**
 * Escapes user-supplied text for inclusion in SVG content. Replaces the
 * five XML special characters with numeric entity references — safe
 * for any UTF-8 string. Truncates to 32 chars so a long collection
 * name doesn't overflow the visual frame.
 */
function escapeForSvg(text: string): string {
  const truncated = text.slice(0, 32)
  return truncated.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

/**
 * UTF-8-safe base64 encoder for the data URI. The native `btoa` only
 * accepts Latin-1; collection names with emoji or non-ASCII characters
 * would throw. Going through encodeURIComponent + unescape converts
 * to a Latin-1-safe sequence first.
 */
function utf8ToBase64(s: string): string {
  if (typeof window === 'undefined') {
    // Server-side path (unlikely caller; SSR doesn't render this) —
    // Buffer is available in Node and produces identical output.
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
    '<text x="300" y="340" text-anchor="middle" font-family="ui-monospace, monospace" font-size="14" fill="#8B5CF6" letter-spacing="3">KISMET</text>' +
    SVG_TEMPLATE_SUFFIX
  return `data:image/svg+xml;base64,${utf8ToBase64(svg)}`
}
