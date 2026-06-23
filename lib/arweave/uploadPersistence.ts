// Cross-reload persistence for completed Arweave media uploads.
//
// MintForm banks a successful media upload in an in-memory ref so a FAILED
// mint retry RESUMES the same Arweave txids instead of re-uploading. This
// matters because data-item ids are the hash of a salted signature, so
// identical bytes ALWAYS get a NEW txid — re-uploading re-bills the upload and
// restarts gateway propagation from zero (see MintForm's UploadedMediaSession
// comment). That in-memory ref is wiped on a page reload / component remount,
// so a creator who reloads after a failed mint re-uploads the same (often very
// large) file for nothing.
//
// This persists the SERIALIZABLE part of the banked session in localStorage,
// keyed by file identity, so the resume survives a reload. The File objects
// themselves are never stored — after a resume MintForm reads the media File
// only for its `.type` (the video animation_url binding), so we persist that
// effective MIME type as a string and rebuild a typed placeholder File.
//
// SAFETY: callers MUST re-verify the stored mediaUri still resolves on Arweave
// before minting with it. File identity (name|size|lastModified) makes a
// wrong-file collision effectively impossible, and the strict pre-reuse verify
// guarantees a stale/corrupt entry can never mint a phantom URI. Entries are
// LRU-capped and TTL'd, and every access is wrapped so a disabled or full
// localStorage can never throw into the mint flow.

const STORAGE_KEY = 'kismet:upload-resume:v1'
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

interface StoredEntry extends PersistedUpload {
  key: string
  savedAt: number
}

// Identity of the user's selection. name+size+lastModified is the same
// fingerprint browsers use to dedupe file inputs; for a re-mint of the same
// artwork it's stable, and a collision between two genuinely different files
// is not a real-world concern — the strict mediaUri verify on reuse is the
// backstop regardless.
function fileKey(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`
}

function isValidEntry(e: unknown): e is StoredEntry {
  if (!e || typeof e !== 'object') return false
  const r = e as Record<string, unknown>
  return (
    typeof r.key === 'string' &&
    typeof r.savedAt === 'number' &&
    typeof r.mediaUri === 'string' &&
    typeof r.mediaType === 'string'
  )
}

function readAll(): StoredEntry[] {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const now = Date.now()
    return parsed.filter((e): e is StoredEntry => isValidEntry(e) && now - e.savedAt < TTL_MS)
  } catch {
    return []
  }
}

function writeAll(entries: StoredEntry[]): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)))
  } catch {
    // Quota exceeded / storage disabled — non-fatal: the resume just won't
    // persist, falling back to today's in-memory-only behaviour.
  }
}

/** The persisted upload for this exact file, or null if none / expired. */
export function loadPersistedUpload(file: File): PersistedUpload | null {
  const entry = readAll().find((e) => e.key === fileKey(file))
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

/**
 * Persist (or refresh) the banked upload for this file. Most-recent-first so
 * the LRU cap in writeAll drops the oldest entry. Overwrites any prior entry
 * for the same file, so a re-upload (new txid) replaces a stale one.
 */
export function savePersistedUpload(file: File, data: PersistedUpload): void {
  const key = fileKey(file)
  const others = readAll().filter((e) => e.key !== key)
  writeAll([{ key, savedAt: Date.now(), ...data }, ...others])
}
