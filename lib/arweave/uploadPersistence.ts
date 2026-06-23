// Cross-reload persistence for completed Arweave uploads.
//
// MintForm and CreateCollectionForm each bank a successful upload in an
// in-memory ref so a FAILED attempt RESUMES the same Arweave txids instead of
// re-uploading. This matters because data-item ids are the hash of a salted
// signature, so identical bytes ALWAYS get a NEW txid — re-uploading re-bills
// the upload and restarts gateway propagation from zero. Those in-memory refs
// are wiped on a page reload / component remount, so a creator who reloads
// after a failed mint or a "settling slowly" deploy block re-uploads the same
// (often very large) file for nothing.
//
// This persists the SERIALIZABLE part of each banked session in localStorage,
// keyed by file identity (name|size|lastModified), LRU-capped and TTL'd. Two
// independent stores:
//   - media (mint): the moment's media bindings. The File objects are never
//     stored — after a resume MintForm reads the media File only for its
//     `.type`, persisted here as a string. Callers MUST re-verify the stored
//     mediaUri resolves before minting (the mint path is non-blocking, so a
//     phantom URI would otherwise mint broken media).
//   - cover (collection create): the cover image URI + thumbhash + strike
//     count. The create path BLOCKS the deploy until the cover URI resolves,
//     so it does NOT pre-verify on reuse — a stale/unpropagated URI can never
//     bake broken metadata on-chain, and skipping the verify means a
//     slow-settling cover is reused, not needlessly re-uploaded.
//
// Every access is wrapped so a disabled or full localStorage can never throw
// into the upload/mint/deploy flow.

const STORAGE_KEY_MEDIA = 'kismet:upload-resume:v1'
const STORAGE_KEY_COVER = 'kismet:cover-resume:v1'
const MAX_ENTRIES = 3
const TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export interface PersistedUpload {
  mediaUri: string
  posterUri: string | null
  thumbhash: string | null
  durationSec: number | null
  needsServerTranscode: boolean
  serverTranscode: { animationUri: string; posterUri: string; thumbhash: string | null } | null
  // Effective (post-transcode) media MIME type — the only thing MintForm reads
  // off the media File after a resume (drives the video animation_url binding).
  mediaType: string
}

export interface PersistedCover {
  imageUri: string
  thumbhash: string | null
  // Propagation-verification strike count, persisted so the retire-after-N
  // logic survives a reload (otherwise each reload resets it and a genuinely
  // lost cover would loop forever instead of eventually re-uploading).
  verifyFailures: number
}

interface StoredEntry {
  key: string
  savedAt: number
}

// Identity of the user's selection. name+size+lastModified is the same
// fingerprint browsers use to dedupe file inputs; for a re-mint/redeploy of the
// same artwork it's stable, and a collision between two genuinely different
// files is not a real-world concern.
function fileKey(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`
}

// Defensive read over a localStorage array of { key, savedAt, ...payload }.
// `hasPayload` confirms a parsed entry carries the fields the caller needs, so a
// corrupt / foreign / partially-written record is dropped rather than reused.
function readEntries<T extends StoredEntry>(
  storageKey: string,
  hasPayload: (e: Record<string, unknown>) => boolean,
): T[] {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(storageKey)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const now = Date.now()
    return parsed.filter((e): e is T => {
      if (!e || typeof e !== 'object') return false
      const r = e as Record<string, unknown>
      return (
        typeof r.key === 'string' &&
        typeof r.savedAt === 'number' &&
        now - r.savedAt < TTL_MS &&
        hasPayload(r)
      )
    })
  } catch {
    return []
  }
}

function writeEntries(storageKey: string, entries: StoredEntry[]): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(storageKey, JSON.stringify(entries.slice(0, MAX_ENTRIES)))
  } catch {
    // Quota exceeded / storage disabled — non-fatal: the resume just won't
    // persist, falling back to today's in-memory-only behaviour.
  }
}

// ─── media (mint) ────────────────────────────────────────────────────────────

interface StoredUpload extends StoredEntry, PersistedUpload {}

const hasMediaPayload = (r: Record<string, unknown>): boolean =>
  typeof r.mediaUri === 'string' && typeof r.mediaType === 'string'

/** The persisted media upload for this exact file, or null if none / expired. */
export function loadPersistedUpload(file: File): PersistedUpload | null {
  const entry = readEntries<StoredUpload>(STORAGE_KEY_MEDIA, hasMediaPayload).find(
    (e) => e.key === fileKey(file),
  )
  if (!entry) return null
  return {
    mediaUri: entry.mediaUri,
    posterUri: entry.posterUri,
    thumbhash: entry.thumbhash,
    durationSec: entry.durationSec,
    needsServerTranscode: entry.needsServerTranscode,
    serverTranscode: entry.serverTranscode,
    mediaType: entry.mediaType,
  }
}

/** Persist (or refresh) the banked media upload for this file, newest-first. */
export function savePersistedUpload(file: File, data: PersistedUpload): void {
  const key = fileKey(file)
  const others = readEntries<StoredUpload>(STORAGE_KEY_MEDIA, hasMediaPayload).filter(
    (e) => e.key !== key,
  )
  writeEntries(STORAGE_KEY_MEDIA, [{ key, savedAt: Date.now(), ...data }, ...others])
}

// ─── cover (collection create) ───────────────────────────────────────────────

interface StoredCover extends StoredEntry, PersistedCover {}

const hasCoverPayload = (r: Record<string, unknown>): boolean =>
  typeof r.imageUri === 'string' && typeof r.verifyFailures === 'number'

/** The persisted cover upload for this exact file, or null if none / expired. */
export function loadPersistedCover(file: File): PersistedCover | null {
  const entry = readEntries<StoredCover>(STORAGE_KEY_COVER, hasCoverPayload).find(
    (e) => e.key === fileKey(file),
  )
  if (!entry) return null
  return {
    imageUri: entry.imageUri,
    thumbhash: entry.thumbhash,
    verifyFailures: entry.verifyFailures,
  }
}

/** Persist (or refresh) the banked cover upload for this file, newest-first. */
export function savePersistedCover(file: File, data: PersistedCover): void {
  const key = fileKey(file)
  const others = readEntries<StoredCover>(STORAGE_KEY_COVER, hasCoverPayload).filter(
    (e) => e.key !== key,
  )
  writeEntries(STORAGE_KEY_COVER, [{ key, savedAt: Date.now(), ...data }, ...others])
}
