import { createHash } from 'node:crypto'
import { CFILE_MAX_BYTES } from './collectorFileTypes.ts'

/**
 * Pure core of the collector-file feature (COLLECTOR_DOWNLOADS_DESIGN.md):
 * chunk encoding, storage math, filename hygiene, and the version/rollback/
 * retention planning — everything whose semantics must be pinnable by the
 * verify harness (scripts/verify-collector-file.ts) without loading
 * Redis-backed modules. Same zero-app-imports pattern as lib/passUnion.
 *
 * STORAGE MODEL (the 2026-08-27 pivot, design doc "Storage pivot"): bytes
 * live IN Upstash Redis as base64 chunk values — the store is private, so
 * the collect-gate is enforced entirely at serve time and no encryption
 * layer exists. Two Upstash facts shape everything here:
 *   - 10 MB per-request/reply cap (REDIS_IMPLEMENTATION_REVIEW.md §4):
 *     chunks are 4 MiB of plaintext (≤ ~5.4 MB encoded) and travel ONE
 *     command per HTTP request — the model layer does chunk I/O on a
 *     dedicated non-auto-pipelining client, because the shared client's
 *     pipeline is client-global and would batch CONCURRENT requests' chunk
 *     commands into one over-cap REST call.
 *   - the shared SDK client JSON-parses GET replies: every chunk is
 *     prefixed 'b' so no base64 value can ever parse as JSON (a pure-digit
 *     chunk would come back as a number).
 */

export const CFILE_CHUNK_BYTES = 4 * 1024 * 1024
/** Bytes are kept for this many most-recent DISTINCT versions (current + 2
 *  rollbackable). Older history rows stay as metadata only — Redis storage
 *  is resident cost, unlike the pointer-only history of the Arweave design. */
export const CFILE_BYTES_RETENTION = 3
export const CFILE_HISTORY_CAP = 20
const CHUNK_PREFIX = 'b'

/** The canonical per-artwork ref used in every key/member: lowercased
 *  collection + minimal-decimal tokenId (the app/api/collect/route.ts:202
 *  canonicalization — "01" must not fork a second record). Throws on a
 *  non-numeric tokenId; routes validate before calling. */
export function cfileRef(collection: string, tokenId: string): string {
  return `${collection.toLowerCase()}:${BigInt(tokenId).toString()}`
}

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

// ---------------------------------------------------------------------------
// Chunk codec + storage math
// ---------------------------------------------------------------------------

export function cfileChunkCount(size: number): number {
  return Math.max(1, Math.ceil(size / CFILE_CHUNK_BYTES))
}

/** Exact stored bytes for a version of `size` plaintext bytes: per chunk,
 *  1 prefix char + base64 length. Pinned against the real codec by verify —
 *  the storage-ceiling accounting is only honest if this never drifts. */
export function cfileStoredBytes(size: number): number {
  let total = 0
  for (let off = 0; off < size; off += CFILE_CHUNK_BYTES) {
    const len = Math.min(CFILE_CHUNK_BYTES, size - off)
    total += 1 + 4 * Math.ceil(len / 3)
  }
  return total
}

export function encodeCfileChunks(data: Buffer): string[] {
  const chunks: string[] = []
  for (let off = 0; off < data.length; off += CFILE_CHUNK_BYTES) {
    chunks.push(CHUNK_PREFIX + data.subarray(off, off + CFILE_CHUNK_BYTES).toString('base64'))
  }
  return chunks
}

/** Decode + reassemble. Throws on a malformed chunk or a length mismatch —
 *  callers map a throw to 500, never to bytes (the sha256 check in the
 *  download route remains the end-to-end integrity authority). */
export function decodeCfileChunks(chunks: string[], size: number): Buffer {
  const parts = chunks.map((c) => {
    if (typeof c !== 'string' || !c.startsWith(CHUNK_PREFIX)) {
      throw new Error('malformed stored chunk')
    }
    return Buffer.from(c.slice(CHUNK_PREFIX.length), 'base64')
  })
  const joined = Buffer.concat(parts)
  if (joined.length !== size) throw new Error('stored chunks do not reassemble to the recorded size')
  return joined
}

// ---------------------------------------------------------------------------
// Upload hygiene
// ---------------------------------------------------------------------------

// Plaintext size ceiling per version: defined once in lib/collectorFileTypes
// (client-safe — the pickers pre-check it) and re-exported here for the
// server + verify-script callers. 2× the MBC5 format ceiling (8 MiB ROM) and
// 45× the reference bundle; each version is resident Redis storage and a
// buffered serve, so the cap is a storage + memory dial, not a format need.
export { CFILE_MAX_BYTES }

/**
 * Accepted collector-file formats, keyed by KIND. Detection is by leading
 * magic bytes ONLY — never by claimed extension or Content-Type header —
 * and the detected kind then dictates both the forced filename extension
 * and the served Content-Type, so name, bytes, and headers can never
 * disagree. A typo filter, not a content control (JAR/DOCX share the zip
 * magic; a PDF's tail matters more than its head) — the real controls are
 * the forced extension, `attachment`, `nosniff`, and the admin kill-switch
 * (design §10.2).
 *
 *   zip  PK\x03\x04             (empty-archive PK\x05\x06 rejected)
 *   pdf  %PDF-                  (ISO 32000 header, offset 0)
 *   glb  glTF                   (Binary glTF magic 0x46546C67 LE — the
 *                                12-byte header per the IANA
 *                                model/gltf-binary registration)
 */
export type CfileKind = 'zip' | 'pdf' | 'glb'

export const CFILE_KINDS: Record<CfileKind, { ext: string; mime: string; magic: number[] }> = {
  zip: { ext: '.zip', mime: 'application/zip', magic: [0x50, 0x4b, 0x03, 0x04] },
  pdf: { ext: '.pdf', mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  glb: { ext: '.glb', mime: 'model/gltf-binary', magic: [0x67, 0x6c, 0x54, 0x46] }, // glTF
}

/** Detect the format from leading bytes; null = not an accepted format. */
export function detectCfileKind(head: Buffer): CfileKind | null {
  for (const [kind, meta] of Object.entries(CFILE_KINDS) as [CfileKind, (typeof CFILE_KINDS)[CfileKind]][]) {
    if (head.length >= meta.magic.length && meta.magic.every((b, i) => head[i] === b)) return kind
  }
  return null
}

/**
 * Normalize an artist-supplied filename for the Content-Disposition header.
 * The raw value is attacker-controlled input into a response header, so:
 * strip everything outside [A-Za-z0-9 ._-] (drops quotes/CRLF/path
 * separators/bidi overrides in one stroke), collapse whitespace, trim
 * leading dots (no hidden files), cap length, force the DETECTED kind's
 * terminal extension (defeats `invoice.pdf.exe`-style double extensions
 * AND extension/content mismatches — a PDF named model.glb serves as
 * .pdf). ASCII-only output — no RFC 6266 `filename*` needed, no quoting
 * ambiguity possible.
 */
export function normalizeCfileName(raw: string | null | undefined, kind: CfileKind = 'zip'): string {
  const cleaned = (raw ?? '')
    .replace(/[^A-Za-z0-9 ._-]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+/, '')
    .trim()
  const lower = cleaned.toLowerCase()
  const claimed = Object.values(CFILE_KINDS).find((m) => lower.endsWith(m.ext))
  const base = (claimed ? cleaned.slice(0, -claimed.ext.length) : cleaned)
    .replace(/[. ]+$/, '')
    .slice(0, 60)
  return `${base || 'collector-file'}${CFILE_KINDS[kind].ext}`
}

// ---------------------------------------------------------------------------
// Record shapes + version/rollback/retention planning (pure, verify-pinned)
// ---------------------------------------------------------------------------

export interface CfileVersion {
  /** Display version, monotonically increasing across replaces AND rollbacks. */
  v: number
  /** Immutable storage id of this version's chunk keys — travels verbatim
   *  through history and rollback, so a rollback re-points at existing bytes
   *  with no re-upload. Assigned once from nextBlobSeq, never reused. */
  blobSeq: number
  /** Chunk-key count for blobSeq (derivable from size; stored so the read
   *  path never depends on the chunking constant of a LATER deploy). */
  chunks: number
  /** Plaintext bytes / sha256 — shown to collectors, used for same-bytes dedup. */
  size: number
  sha256: string
  /** Detected format (magic-derived, never claimed) — dictates the served
   *  Content-Type. Absent on records written before formats beyond zip
   *  existed; readers default to 'zip'. */
  kind?: CfileKind
  name: string
  note?: string
  updatedAt: number
  updatedBy: string
  /** True while this version's chunk keys exist. Retention (attach pruning,
   *  detach) clears it — POSITION in history can't tell you this, because
   *  detach deletes bytes while keeping the rows. Only stored versions are
   *  rollback targets. */
  stored?: true
}

export interface CfileRecord {
  /** Active version, or null when detached (DELETE frees the bytes;
   *  history rows stay for the artist's record). */
  current: CfileVersion | null
  /** Superseded versions, newest first, capped — metadata rows (~250 B). */
  history: CfileVersion[]
  /** Next blobSeq. NEVER decremented or reused — history is capped, so
   *  deriving this from what's visible would eventually re-mint a live
   *  version's chunk keys for new bytes. */
  nextBlobSeq: number
  createdAt: number
}

export interface CfileBlobRef {
  blobSeq: number
  chunks: number
}

function nextVersionNumber(record: CfileRecord | null): number {
  if (!record) return 1
  const vs = [record.current?.v ?? 0, ...record.history.map((h) => h.v)]
  return Math.max(...vs) + 1
}

function allVersions(record: CfileRecord): CfileVersion[] {
  return record.current ? [record.current, ...record.history] : record.history
}

/** blobSeq → chunk count for every version whose chunk keys currently
 *  exist, per the record's own flags. A Map (not a Set) so pruning can name
 *  the keys of a blob even after the history cap trimmed its last row. */
export function storedBlobRefs(record: CfileRecord | null): Map<number, number> {
  const out = new Map<number, number>()
  if (!record) return out
  for (const v of allVersions(record)) if (v.stored) out.set(v.blobSeq, v.chunks)
  return out
}

/** May history version `v` be rolled back to? Only while its bytes are
 *  retained (the UI's `restorable`). */
export function isCfileVersionRestorable(record: CfileRecord, v: number): boolean {
  return !!record.history.find((h) => h.v === v)?.stored
}

/** Total resident bytes a record accounts for — DISTINCT stored blobSeqs
 *  (rollback duplicates a seq across rows; the bytes exist once). Feeds the
 *  global storage-ceiling hash. */
export function recordStoredBytes(record: CfileRecord | null): number {
  if (!record) return 0
  const seen = new Set<number>()
  let total = 0
  for (const v of allVersions(record)) {
    if (v.stored && !seen.has(v.blobSeq)) {
      seen.add(v.blobSeq)
      total += cfileStoredBytes(v.size)
    }
  }
  return total
}

/**
 * Enforce the retention window on a freshly-planned record: keep bytes for
 * the first CFILE_BYTES_RETENTION distinct blobSeqs (in recency order) that
 * currently have bytes, drop the rest. Returns the record with `stored`
 * flags rewritten plus the blobs whose chunk keys the caller must delete.
 * A blob that lost its bytes earlier (e.g. across a detach) can never
 * re-enter the window — bytes don't come back by reordering.
 */
function applyRetention(
  record: CfileRecord,
  previouslyStored: Map<number, number>,
): { record: CfileRecord; prune: CfileBlobRef[] } {
  const keep = new Set<number>()
  for (const v of allVersions(record)) {
    if (keep.size >= CFILE_BYTES_RETENTION) break
    if (previouslyStored.has(v.blobSeq)) keep.add(v.blobSeq)
  }
  const flag = (v: CfileVersion): CfileVersion => {
    const { stored: _s, ...rest } = v
    return keep.has(v.blobSeq) ? { ...rest, stored: true } : rest
  }
  return {
    record: {
      ...record,
      current: record.current ? flag(record.current) : null,
      history: record.history.map(flag),
    },
    // Chunk counts come from the PRE-mutation map: a blob whose last history
    // row was trimmed this mutation must still get its keys deleted.
    prune: [...previouslyStored]
      .filter(([seq]) => !keep.has(seq))
      .map(([blobSeq, chunks]) => ({ blobSeq, chunks })),
  }
}

/** Plan attaching new bytes: the version to write, the updated record, and
 *  the blobs falling out of the retention window (delete their chunk keys in
 *  the same commit). `null` when the bytes are identical to the current
 *  version — a nervous double-upload must not burn a version, a meter, or
 *  the notify cooldown. */
export function planAttach(
  record: CfileRecord | null,
  input: { size: number; sha256: string; kind: CfileKind; name: string; note?: string; updatedBy: string; now: number },
): { record: CfileRecord; version: CfileVersion; prune: CfileBlobRef[] } | null {
  if (record?.current && record.current.sha256 === input.sha256) return null
  const seq = record?.nextBlobSeq ?? 1
  const version: CfileVersion = {
    v: nextVersionNumber(record),
    blobSeq: seq,
    chunks: cfileChunkCount(input.size),
    size: input.size,
    sha256: input.sha256,
    kind: input.kind,
    name: input.name,
    ...(input.note ? { note: input.note } : {}),
    updatedAt: input.now,
    updatedBy: input.updatedBy.toLowerCase(),
    stored: true,
  }
  const history = record?.current ? [record.current, ...(record?.history ?? [])] : (record?.history ?? [])
  const previouslyStored = storedBlobRefs(record)
  previouslyStored.set(seq, version.chunks)
  const retained = applyRetention(
    {
      current: version,
      history: history.slice(0, CFILE_HISTORY_CAP),
      nextBlobSeq: seq + 1,
      createdAt: record?.createdAt ?? input.now,
    },
    previouslyStored,
  )
  const current = retained.record.current
  if (!current) throw new Error('planAttach lost its own current version') // unreachable
  return { record: retained.record, version: current, prune: retained.prune }
}

/** Plan a rollback: re-activate history version `v` as a NEW display version
 *  carrying its original blobSeq/chunks verbatim — the bytes already exist,
 *  no re-upload. Returns null when `v` isn't in history OR its bytes left
 *  the retention window (routes distinguish via isCfileVersionRestorable).
 *  Provably prunes nothing: the revived seq was already retained. */
export function planRollback(
  record: CfileRecord,
  v: number,
  updatedBy: string,
  now: number,
): { record: CfileRecord; prune: CfileBlobRef[] } | null {
  const target = record.history.find((h) => h.v === v)
  if (!target?.stored) return null
  const revived: CfileVersion = {
    ...target,
    v: nextVersionNumber(record),
    updatedAt: now,
    updatedBy: updatedBy.toLowerCase(),
  }
  const history = record.current ? [record.current, ...record.history] : record.history
  return applyRetention(
    { ...record, current: revived, history: history.slice(0, CFILE_HISTORY_CAP) },
    storedBlobRefs(record),
  )
}

/** Plan a detach: serving stops AND the bytes are freed (real deletion —
 *  the point of the Redis pivot); history rows stay as the artist's record,
 *  all non-restorable. */
export function planDetach(record: CfileRecord): { record: CfileRecord; prune: CfileBlobRef[] } {
  const history = record.current ? [record.current, ...record.history] : record.history
  const strip = (v: CfileVersion): CfileVersion => {
    const { stored: _s, ...rest } = v
    return rest
  }
  return {
    record: {
      ...record,
      current: null,
      history: history.slice(0, CFILE_HISTORY_CAP).map(strip),
    },
    prune: [...storedBlobRefs(record)].map(([blobSeq, chunks]) => ({ blobSeq, chunks })),
  }
}
