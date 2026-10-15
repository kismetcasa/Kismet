import { CFILE_MAX_BYTES, formatCfileSize } from '../collectorFileTypes.ts'
import { ZINE_MAX_PAGES, readZineHint, type ZineAccess, type ZineHint } from './zineHint'

export { ZINE_MAX_PAGES, readZineHint, type ZineAccess, type ZineHint }
import { PDF_MAGIC, PDF_MIME, hasPdfMagic } from '../pdfFormat.ts'

/**
 * Primary-media helpers for a ZINE — a PDF minted as the artwork and read
 * page by page (ZINE_READER_DESIGN.md). The mint-side counterpart to
 * lib/media/modelMedia for 3D.
 *
 * A zine is minted with the SAME metadata shape as a video or 3D moment —
 * `image` (the cover, a real JPEG), `animation_url` (the PDF) and
 * `content.mime` (`application/pdf`) — so every static surface (feed cards,
 * OG cards, Farcaster embeds, covers, thumbhash) keeps working with no
 * knowledge of PDFs. Only the artwork detail view opens a reader, and only
 * behind a tap.
 *
 * "Zine" is the product word everywhere (badge, copy, the metadata hint);
 * it is deliberately not "PDF", which is what a collector DOWNLOAD may be.
 * Any PDF can be a zine — a comic, a photo book, a catalogue.
 *
 * Pure: no DOM, no pdf.js. The PDF parser is injected (`PdfInspector`) so
 * the gate stays testable in Node and the ~150 KB pdf.js chunk loads only
 * on the surfaces that render pages (lib/pdfjs).
 */


/**
 * Hard byte ceiling — ONE number with the collector-file store
 * (`CFILE_MAX_BYTES`), so switching an artwork between a public zine and a
 * collectors-only one never hits a different wall, and with the artwork
 * page's owned download (`lib/media/modelFetch` caps at the same 64 MiB).
 * A zine is not streamed: the reader downloads the whole file before the
 * first page and pdf.js holds it in its worker for the whole session, which
 * is why the 420 MB media cap sized for ranged video is wrong here — the
 * same argument modelMedia makes for GLB. 420 scanned pages at ~150 KB each
 * is ~63 MB, so the page cap and the byte cap describe the same zine.
 */
export const ZINE_MAX_BYTES = CFILE_MAX_BYTES

/** Above this, warn (but allow): v1 downloads the whole file before page 1,
 *  so on a phone link this is the size where the wait becomes a real one. */
export const ZINE_SOFT_WARN_BYTES = 16 * 1024 * 1024

/** The long edge, in pixels, that "optimize for phones" re-renders every
 *  page at (lib/media/optimizePdf). 2000 px is above any phone's width at
 *  3× DPR for a portrait page and a third of the pixels of a 300 dpi A4
 *  scan — pure here so the mint form's copy can name it without the
 *  optimizer module. */
export const ZINE_OPTIMIZE_LONG_EDGE = 2000


/** `metadata.kismet_zine` — the discovery and badge signal (a page count
 *  without fetching the PDF). RENDERING never keys on it: the resolver
 *  classifies by `content.mime`; the hint is a second signal for an index
 *  row that lost its `content` field, and it is harmless when stale. */

export type PdfInspection =
  | { kind: 'ok'; pages: number }
  | { kind: 'password' }
  | { kind: 'unreadable' }

/** Parses a PDF far enough to count its pages and detect a user password.
 *  The browser implementation is lib/pdfjs.inspectPdfFile. */
export type PdfInspector = (file: File) => Promise<PdfInspection>

/** Magic-byte sniff of a picked file — never the extension or `File.type`. */
export async function sniffPdfFile(file: File): Promise<boolean> {
  if (file.size < PDF_MAGIC.length) return false
  const head = new Uint8Array(await file.slice(0, PDF_MAGIC.length).arrayBuffer())
  return hasPdfMagic(head)
}

/** Re-wrap with the real MIME so the Arweave `Content-Type` tag, the
 *  animation binding and the resume path's persisted `mediaType` all agree
 *  (browsers normally report `application/pdf` for a `.pdf`, but a file
 *  arriving from an archive or some Android pickers can present as ''). */
export function asPdfFile(file: File): File {
  if (file.type === PDF_MIME) return file
  return new File([file], file.name, { type: PDF_MIME, lastModified: file.lastModified })
}

export function formatZinePages(pages: number): string {
  return pages === 1 ? '1 page' : `${pages} pages`
}

/** Every user-facing string derives from the constants above — never
 *  hardcode a cap in copy (the collector-file "16 MB" lesson). */
export const ZINE_COPY = {
  tooLarge: (bytes: number): string =>
    `Zines are capped at ${formatCfileSize(ZINE_MAX_BYTES)} — this one is ${formatCfileSize(bytes)}`,
  tooManyPages: (pages: number): string =>
    `Zines are capped at ${ZINE_MAX_PAGES} pages — this one has ${pages}`,
  password: 'Password-protected PDFs can’t be read by collectors — export it without a password',
  unreadable: 'This PDF could not be read — try re-exporting it',
  /** The gate ran without a PDF parser: the edit flow and the machine stage
   *  frames, where a PDF is not a supported replacement. */
  notHere: 'A PDF mints as a zine from the mint form',
  largeWarning: (bytes: number): string =>
    `${formatCfileSize(bytes)} — readers on phones download the whole zine before the first page; under ${formatCfileSize(ZINE_SOFT_WARN_BYTES)} keeps that to a few seconds`,
  noCover: 'Could not render a cover from this PDF — pick another page as the cover, or upload a cover image',
  readerUnavailable: 'The reader could not start in this browser — open the PDF instead',
  /** The mode control in the mint form. */
  accessLabel: 'Who can read it',
  accessPublic: 'everyone',
  accessPublicHint: 'the PDF is stored on Arweave — public and permanent',
  accessCollectors: 'collectors only',
  accessCollectorsHint:
    'stored privately on Kismet; only the cover is public — your first page, unless you upload a different cover. You can replace the zine later and collectors are notified.',
  collectorsSlot: (pages: number): string => `the zine is the collector file · ${formatZinePages(pages)} — only collectors can read it`,
  collectorsAttaching: 'Minted — attaching the zine for collectors…',
  collectorsAttached: 'Collectors can read it from the artwork page.',
  collectorsAttachFailed: (why: string): string => `${why} — attach the PDF from the artwork page (file button)`,
  collectToRead: 'collect to read',
  collectedReady: 'your zine is ready — read it',
  /** A collector opening a password-protected PDF in the viewer. */
  passwordCollector: 'This PDF is password-protected — download it and open it with the password',
  /** The artist attaching one as the collector file. */
  passwordCfile: 'Collectors can download it, but not read it here — attach a copy without a password to make it readable',
} as const

export type ZineMomentInput =
  /** Public: the PDF is on Arweave and rides the video/3D binding. */
  | { access: 'public'; pdfUri: string; coverUri: string; pages: number; thumbhash?: string | null }
  /** Collectors-only: an image moment (the cover) whose pages live in the
   *  private collector-file store; only the hint says it is a zine. */
  | { access: 'collectors'; coverUri: string; pages: number; thumbhash?: string | null }

/**
 * The metadata fields of a zine — ONE definition for every producer (the
 * mint form today; the edit flow and the agent mint when they learn zines),
 * so none can drift from the shape the resolver and the oracle expect: the
 * cover in `image`, the PDF in `animation_url` + `content` when it is
 * public, and the hint in both modes.
 */
export function zineMomentFields(input: ZineMomentInput): {
  image: string
  animation_url?: string
  content?: { uri: string; mime: string }
  kismet_thumbhash?: string
  kismet_zine: ZineHint
} {
  return {
    image: input.coverUri,
    ...(input.access === 'public'
      ? { animation_url: input.pdfUri, content: { uri: input.pdfUri, mime: PDF_MIME } }
      : {}),
    ...(input.thumbhash ? { kismet_thumbhash: input.thumbhash } : {}),
    kismet_zine: { pages: input.pages, access: input.access },
  }
}

