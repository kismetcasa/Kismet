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
// keyed by file identity (name|size|lastModified) or, for JSON, by the
// serialized content itself; LRU-capped and TTL'd. Three independent stores:
//   - media (mint): the moment's media bindings. The File objects are never
//     stored — after a resume MintForm reads the media File only for its
//     `.type`, persisted here as a string (mediaType). Rehydrate is
//     UNCONDITIONAL on a file-identity match: the bytes are PERMANENT once Turbo
//     returns the txid, so there is no phantom-URI risk worth a re-upload, and
//     the non-blocking propagation verify is just a display spinner.
//   - editMedia (edit-moment): a DISTINCT store (not the mint one) holding the
//     resolved {animationUri | null, imageUri | null, thumbhash} the edit flow
//     needs. Kept separate so it can never read a mint entry (whose mediaType /
//     serverTranscode semantics differ); the PRESENCE of animationUri — not a
//     mime string — tells a video binding from a still image. Same soft-gate as
//     create: a not-yet-propagated reuse self-heals on display.
//   - cover (collection create + edit, edit-moment): the cover image URI +
//     thumbhash + strike count. All callers soft-gate propagation (proceed even
//     if the cover hasn't settled; it self-heals on display), so a reused-but-
//     unsettled cover is reused, not needlessly re-uploaded.
//   - json (mint + collection create/edit + edit-moment): the small moment /
//     contract metadata JSON, content-keyed (there is no File). Every flow
//     soft-gates propagation and mints / deploys / updates anyway, so a reload
//     reuses the durable txid instead of re-billing a byte-identical upload;
//     carries a strike count like the cover so a genuinely lost upload self-heals.
//
// Every access is wrapped so a disabled or full localStorage can never throw
// into the upload/mint/deploy flow.

const STORAGE_KEY_MEDIA = 'kismet:upload-resume:v1'
const STORAGE_KEY_EDIT_MEDIA = 'kismet:edit-media-resume:v1'
const STORAGE_KEY_COVER = 'kismet:cover-resume:v1'
const STORAGE_KEY_JSON = 'kismet:json-resume:v1'
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

// ─── edit-moment media ───────────────────────────────────────────────────────
// A SEPARATE store from the mint media above — deliberately not shared. Mint
// banks its raw bytes under STORAGE_KEY_MEDIA with mint-specific semantics (e.g.
// a server-transcoded GIF stores mediaUri = the RAW GIF and the real MP4 only in
// `serverTranscode`, with mediaType 'image/gif'). The edit-moment flow doesn't
// read `serverTranscode`, so reading a mint entry would misclassify that GIF as
// a still image and bake the raw-GIF txid on-chain. Keeping a distinct key makes
// a cross-flow read impossible. Here the PRESENCE of animationUri — not a mime
// string — discriminates a video binding from a still image, so there is no mime
// convention to drift.

export interface PersistedEditMedia {
  // The mp4 animation binding (video / transcoded GIF), or null for a still image.
  animationUri: string | null
  // Poster for a video, or the still image itself; null when a separate cover
  // is being set (the cover supplies `image`).
  imageUri: string | null
  thumbhash: string | null
}

interface StoredEditMedia extends StoredEntry, PersistedEditMedia {}

const hasEditMediaPayload = (r: Record<string, unknown>): boolean =>
  (typeof r.animationUri === 'string' || r.animationUri === null) &&
  (typeof r.imageUri === 'string' || r.imageUri === null) &&
  // At least one real URI — an all-null record carries no resumable upload.
  (typeof r.animationUri === 'string' || typeof r.imageUri === 'string')

/** The persisted edit-moment media for this exact file, or null if none / expired. */
export function loadPersistedEditMedia(file: File): PersistedEditMedia | null {
  const entry = readEntries<StoredEditMedia>(STORAGE_KEY_EDIT_MEDIA, hasEditMediaPayload).find(
    (e) => e.key === fileKey(file),
  )
  if (!entry) return null
  return { animationUri: entry.animationUri, imageUri: entry.imageUri, thumbhash: entry.thumbhash }
}

/** Persist (or refresh) the banked edit-moment media for this file, newest-first. */
export function savePersistedEditMedia(file: File, data: PersistedEditMedia): void {
  const key = fileKey(file)
  const others = readEntries<StoredEditMedia>(STORAGE_KEY_EDIT_MEDIA, hasEditMediaPayload).filter(
    (e) => e.key !== key,
  )
  writeEntries(STORAGE_KEY_EDIT_MEDIA, [{ key, savedAt: Date.now(), ...data }, ...others])
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

// ─── json (moment + collection metadata) ─────────────────────────────────────
// Used by MintForm (moment metadata, auto-deploy collection metadata),
// CreateCollectionForm (contract metadata), and EditCollectionForm (updated
// contract metadata). Unlike media/cover there is no File
// — the identity IS the serialized content, so the caller passes
// JSON.stringify(metadata) as the key. Without this, a page reload (e.g. to
// escape a stuck wallet request or failed mint) re-uploads the byte-identical
// metadata JSON under a fresh Turbo txid, re-billing the credit every time.
// Carries a strike count like the cover so retire-after-N survives reloads.

export interface PersistedJson {
  uri: string
  failures: number
}

interface StoredJson extends StoredEntry, PersistedJson {}

const hasJsonPayload = (r: Record<string, unknown>): boolean =>
  typeof r.uri === 'string' && typeof r.failures === 'number'

/** The persisted JSON upload for this exact serialized content, or null. */
export function loadPersistedJson(contentKey: string): PersistedJson | null {
  const entry = readEntries<StoredJson>(STORAGE_KEY_JSON, hasJsonPayload).find(
    (e) => e.key === contentKey,
  )
  if (!entry) return null
  return { uri: entry.uri, failures: entry.failures }
}

/** Persist (or refresh) the banked JSON upload for this content, newest-first. */
export function savePersistedJson(contentKey: string, data: PersistedJson): void {
  const others = readEntries<StoredJson>(STORAGE_KEY_JSON, hasJsonPayload).filter(
    (e) => e.key !== contentKey,
  )
  writeEntries(STORAGE_KEY_JSON, [{ key: contentKey, savedAt: Date.now(), ...data }, ...others])
}
