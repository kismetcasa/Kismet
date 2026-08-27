// Client-safe types + tiny display helpers for the collector-file feature —
// the server model (lib/collectorFile) is 'server-only', so the shapes the
// UI consumes live here. No imports.

/** Plaintext size ceiling per version — the ONE definition every picker and
 *  the server enforce (a "dial" per the design; changing it here changes it
 *  everywhere). Client-safe so the mint form and manage panel can pre-check
 *  without importing server code. */
export const CFILE_MAX_BYTES = 16 * 1024 * 1024

/** One shared B/KB/MB formatter for the card + manage panel + mint form. */
export function formatCfileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** The public descriptor: display facts only — never uri/iv/keyId. */
export interface CfilePublic {
  name: string
  size: number
  sha256: string
  v: number
  updatedAt: number
  note?: string
  pending?: boolean
}

export interface CfileManageView {
  file: CfilePublic | null
  history: { v: number; name: string; size: number; sha256: string; updatedAt: number; note?: string }[]
  downloaders: number
  audience: number
  fanoutCeiling: number
  notifyCooldownSecs: number
}
