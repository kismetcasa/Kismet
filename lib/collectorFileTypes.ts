// Client-safe types for the collector-file feature — the server model
// (lib/collectorFile) is 'server-only', so the shapes the UI consumes live
// here. Pure declarations, no imports.

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
