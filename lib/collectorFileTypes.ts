// Client-safe types + tiny display helpers for the collector-file feature —
// the server model (lib/collectorFile) is 'server-only', so the shapes the
// UI consumes live here. No imports.

/** Plaintext size ceiling per version — the ONE definition every picker and
 *  the server enforce (a "dial" per the design; changing it here changes it
 *  everywhere). Client-safe so the mint form and manage panel can pre-check
 *  without importing server code. */
export const CFILE_MAX_BYTES = 16 * 1024 * 1024

/** The accepted formats. Extension + MIME live HERE (client-safe, no
 *  imports) and lib/collectorFileCore builds its detection registry from
 *  this map by adding magic bytes — so a kind's identity has exactly one
 *  definition that both the pickers and the server share. */
export type CfileKind = 'zip' | 'pdf' | 'glb' | 'svg'

export const CFILE_KIND_META: Record<CfileKind, { ext: string; mime: string }> = {
  zip: { ext: '.zip', mime: 'application/zip' },
  pdf: { ext: '.pdf', mime: 'application/pdf' },
  glb: { ext: '.glb', mime: 'model/gltf-binary' },
  svg: { ext: '.svg', mime: 'image/svg+xml' },
}

/** Kinds the in-page viewer renders. PDF is deliberately absent (it opens
 *  natively everywhere; honest in-page rendering on iOS would cost a pdf.js
 *  dependency for convenience alone) and zip has nothing to render. */
export const CFILE_VIEWABLE_KINDS: readonly CfileKind[] = ['glb', 'svg']

export function isViewableCfileKind(kind: CfileKind | undefined): boolean {
  return !!kind && CFILE_VIEWABLE_KINDS.includes(kind)
}

export const CFILE_ACCEPT_EXTS = Object.values(CFILE_KIND_META).map((m) => m.ext)
export const CFILE_ACCEPT_ATTR = [
  ...CFILE_ACCEPT_EXTS,
  ...Object.values(CFILE_KIND_META).map((m) => m.mime),
].join(',')
export const CFILE_KIND_LABEL = 'zip, PDF, 3D model (.glb) or SVG'

export function hasAcceptedCfileExt(name: string): boolean {
  const lower = name.toLowerCase()
  return CFILE_ACCEPT_EXTS.some((ext) => lower.endsWith(ext))
}

/** One shared B/KB/MB formatter for the card + manage panel + mint form. */
export function formatCfileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** The public descriptor: display facts only — never storage internals. */
export interface CfilePublic {
  name: string
  size: number
  sha256: string
  v: number
  updatedAt: number
  note?: string
  /** Magic-detected format. Absent on records written before multi-format
   *  support — those are all zips, and callers default accordingly. */
  kind?: CfileKind
}

export interface CfileManageView {
  file: CfilePublic | null
  history: {
    v: number
    name: string
    size: number
    sha256: string
    updatedAt: number
    note?: string
    /** Bytes still stored → rollback offered. Older versions keep their row
     *  but fall out of the retention window (re-upload to bring one back). */
    restorable: boolean
  }[]
  downloaders: number
  audience: number
  fanoutCeiling: number
  notifyCooldownSecs: number
}
