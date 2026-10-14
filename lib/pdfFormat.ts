/**
 * The PDF format identity — extension, MIME, magic bytes — in ONE place,
 * because TWO features accept a PDF and they must agree (the same rule
 * lib/glbFormat states for GLB):
 *
 *   - primary mint media: a zine (lib/media/zineMedia, MintForm, the reader)
 *   - collector downloads (lib/collectorFileTypes -> lib/collectorFileCore)
 *
 * An artist who drops the same file into the MEDIA slot and the collector-
 * download slot must get the same verdict on what it is. These are SPEC
 * constants — the IANA `application/pdf` registration and the ISO 32000
 * file header — not per-feature choices.
 *
 * Client-safe by construction: zero imports, no Node built-ins, no DOM.
 */

export const PDF_EXT = '.pdf'

/** IANA-registered media type for PDF. */
export const PDF_MIME = 'application/pdf'

/** ISO 32000 header: ASCII "%PDF-" at byte 0. The spec tolerates junk
 *  before the header, but every real exporter writes it at offset 0 and the
 *  collector-file detector has always required it there; one rule, both
 *  features. */
export const PDF_MAGIC: readonly number[] = [0x25, 0x50, 0x44, 0x46, 0x2d]

/**
 * Magic-byte test — the ONLY trustworthy answer to "is this a PDF?". The
 * claimed extension and the browser-supplied `File.type` are both caller-
 * controlled; a gateway's HTML landing page claims whatever it likes.
 */
export function hasPdfMagic(head: Uint8Array): boolean {
  return head.length >= PDF_MAGIC.length && PDF_MAGIC.every((b, i) => head[i] === b)
}

export function hasPdfExt(name: string): boolean {
  return name.toLowerCase().endsWith(PDF_EXT)
}
