// Client-safe types + tiny display helpers for the collector-file feature —
// the server model (lib/collectorFile) is 'server-only', so the shapes the
// UI consumes live here. No imports.

/** Plaintext size ceiling per version — the ONE definition every picker and
 *  the server enforce (a "dial" per the design; changing it here changes it
 *  everywhere). Client-safe so the mint form and manage panel can pre-check
 *  without importing server code. */
export const CFILE_MAX_BYTES = 16 * 1024 * 1024

/** Accepted formats, ONE definition for both pickers (server truth is the
 *  magic-byte detection in lib/collectorFileCore — this is the client-side
 *  pre-check + <input accept>). */
export const CFILE_ACCEPT_EXTS = ['.zip', '.pdf', '.glb'] as const
export const CFILE_ACCEPT_ATTR = '.zip,.pdf,.glb,application/zip,application/pdf,model/gltf-binary'
export const CFILE_KIND_LABEL = 'zip, PDF, or 3D model (.glb)'

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
