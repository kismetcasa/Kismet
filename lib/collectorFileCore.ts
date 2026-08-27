import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { CFILE_MAX_BYTES } from './collectorFileTypes.ts'

/**
 * Pure core of the collector-file feature (COLLECTOR_DOWNLOADS_DESIGN.md):
 * key derivation, AEAD seal/open, filename hygiene, and the version/rollback
 * planning — everything whose semantics must be pinnable by the verify
 * harness (scripts/verify-collector-file.ts) without loading Redis-backed
 * modules. Same zero-app-imports pattern as lib/passUnion + lib/gateFlags.
 *
 * THE ONE UNREPAIRABLE INVARIANT lives here: ciphertexts on Arweave are
 * permanent, so the HKDF inputs and AAD format below may NEVER change once a
 * ciphertext exists. keyIds are minted once per ciphertext (monotonic
 * `nextKeySeq`, never reused, never derived from the mutable display version
 * `v`) precisely so rollback re-activates old bytes decryptably — deriving
 * from `v` was rev-1's data-loss bug (§13). verify-collector-file pins a
 * known-answer test over deriveKey + seal/open before anything else.
 */

// ---------------------------------------------------------------------------
// Frozen crypto constants — changing any of these bricks every prior version.
// ---------------------------------------------------------------------------

export const CFILE_HKDF_SALT = 'kismet-cfile-v1'
export const CFILE_KEY_BYTES = 32
export const CFILE_IV_BYTES = 12
// GCM accepts short forged tags unless the length is pinned on BOTH sides.
export const CFILE_TAG_BYTES = 16

/** The canonical per-artwork ref used in every key/member: lowercased
 *  collection + minimal-decimal tokenId (the app/api/collect/route.ts:202
 *  canonicalization — "01" must not fork a second record). Throws on a
 *  non-numeric tokenId; routes validate before calling. */
export function cfileRef(collection: string, tokenId: string): string {
  return `${collection.toLowerCase()}:${BigInt(tokenId).toString()}`
}

/** keyId for the n-th ciphertext of an artwork. Immutable once minted. */
export function cfileKeyId(collection: string, tokenId: string, seq: number): string {
  return `${cfileRef(collection, tokenId)}:${seq}`
}

/** AAD binds a ciphertext to its artwork slot so a Redis-level pointer swap
 *  between two artworks can never decrypt. */
export function cfileAad(keyId: string): Buffer {
  return Buffer.from(`${CFILE_HKDF_SALT}|${keyId}`, 'utf8')
}

export function deriveCfileKey(masterKeyBase64: string, keyId: string): Buffer {
  const master = Buffer.from(masterKeyBase64, 'base64')
  if (master.length < 32) throw new Error('COLLECTOR_FILE_MASTER_KEY must be ≥32 bytes (base64)')
  return Buffer.from(
    hkdfSync('sha256', master, Buffer.from(CFILE_HKDF_SALT, 'utf8'), Buffer.from(keyId, 'utf8'), CFILE_KEY_BYTES),
  )
}

export interface SealedCfile {
  /** iv ∥ ciphertext ∥ tag — one buffer, uploaded as-is. */
  sealed: Buffer
  /** base64 iv, stored on the version record for visibility/debugging. */
  iv: string
}

/** AES-256-GCM seal. Layout: [12B iv][ciphertext][16B tag]. */
export function sealCfile(masterKeyBase64: string, keyId: string, plaintext: Buffer): SealedCfile {
  const key = deriveCfileKey(masterKeyBase64, keyId)
  const iv = randomBytes(CFILE_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: CFILE_TAG_BYTES })
  cipher.setAAD(cfileAad(keyId))
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return { sealed: Buffer.concat([iv, body, tag]), iv: iv.toString('base64') }
}

/** AES-256-GCM open. Throws on any tampering/mismatch (wrong keyId, wrong
 *  artwork, truncated body) — callers map a throw to 500, never to bytes. */
export function openCfile(masterKeyBase64: string, keyId: string, sealed: Buffer): Buffer {
  if (sealed.length < CFILE_IV_BYTES + CFILE_TAG_BYTES + 1) {
    throw new Error('sealed payload too short')
  }
  const key = deriveCfileKey(masterKeyBase64, keyId)
  const iv = sealed.subarray(0, CFILE_IV_BYTES)
  const tag = sealed.subarray(sealed.length - CFILE_TAG_BYTES)
  const body = sealed.subarray(CFILE_IV_BYTES, sealed.length - CFILE_TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: CFILE_TAG_BYTES })
  decipher.setAAD(cfileAad(keyId))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

// ---------------------------------------------------------------------------
// Upload hygiene
// ---------------------------------------------------------------------------

// Plaintext size ceiling per version: defined once in lib/collectorFileTypes
// (client-safe — the pickers pre-check it) and re-exported here for the
// server + verify-script callers. 2× the MBC5 format ceiling (8 MiB ROM) and
// 45× the reference bundle; each version is a PERMANENT Turbo spend (~$0.51
// worst case at retail) and a buffered decrypt, so the cap is a cost +
// memory dial, not a format need (design §3.2/§10.1).
export { CFILE_MAX_BYTES }

/** Local-file zips start `PK\x03\x04`. A typo filter, not a content control
 *  (JAR/DOCX share the magic; readers parse from the end-of-central-directory)
 *  — the real controls are the forced .zip name, `attachment`, `nosniff`, and
 *  the admin kill-switch (design §10.2). An empty archive (`PK\x05\x06`) is
 *  rejected as "not a usable zip" rather than stored. */
export function looksLikeZip(head: Buffer): boolean {
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
}

/**
 * Normalize an artist-supplied filename for the Content-Disposition header.
 * The raw value is attacker-controlled input into a response header, so:
 * strip everything outside [A-Za-z0-9 ._-] (drops quotes/CRLF/path
 * separators/bidi overrides in one stroke), collapse whitespace, trim
 * leading dots (no hidden files), cap length, force a terminal `.zip`
 * (defeats `invoice.pdf.exe`-style double extensions). ASCII-only output —
 * no RFC 6266 `filename*` needed, no quoting ambiguity possible.
 */
export function normalizeCfileName(raw: string | null | undefined): string {
  const cleaned = (raw ?? '')
    .replace(/[^A-Za-z0-9 ._-]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+/, '')
    .trim()
  const base = (cleaned.toLowerCase().endsWith('.zip') ? cleaned.slice(0, -4) : cleaned)
    .replace(/[. ]+$/, '')
    .slice(0, 60)
  return `${base || 'collector-file'}.zip`
}

// ---------------------------------------------------------------------------
// Record shapes + version/rollback planning (pure, verify-pinned)
// ---------------------------------------------------------------------------

export interface CfileVersion {
  /** Display version, monotonically increasing across replaces AND rollbacks. */
  v: number
  /** Immutable key-derivation id of this ciphertext — travels verbatim
   *  through history and rollback (the §13.1 fix). */
  keyId: string
  /** ar:// txid of the SEALED bytes. Never surfaced to clients. */
  uri: string
  iv: string
  /** Plaintext bytes / sha256 — shown to collectors, used for same-bytes dedup. */
  size: number
  sha256: string
  name: string
  note?: string
  updatedAt: number
  updatedBy: string
  /** True until a gateway served the txid (verifyArweaveAvailable); a pending
   *  current version answers downloads 503-propagating, not 404. */
  pending?: boolean
}

export interface CfileRecord {
  /** Active version, or null when detached (DELETE tombstones serving;
   *  history stays for the artist). */
  current: CfileVersion | null
  /** Superseded versions, newest first, capped — pointer records only
   *  (~300 B each); the ciphertexts live on Arweave regardless. */
  history: CfileVersion[]
  /** Next keyId sequence number. NEVER decremented or reused — history is
   *  capped, so deriving this from what's visible would eventually re-mint
   *  an old keyId for new bytes. */
  nextKeySeq: number
  createdAt: number
}

export const CFILE_HISTORY_CAP = 20

function nextVersionNumber(record: CfileRecord | null): number {
  if (!record) return 1
  const vs = [record.current?.v ?? 0, ...record.history.map((h) => h.v)]
  return Math.max(...vs) + 1
}

/** Plan attaching new bytes: returns the version to write plus the updated
 *  record. `null` when the bytes are identical to the current version (a
 *  nervous double-upload must not burn a version, a Turbo spend, or the
 *  notify cooldown). */
export function planAttach(
  record: CfileRecord | null,
  input: { keyIdSeqRef: string; uri: string; iv: string; size: number; sha256: string; name: string; note?: string; updatedBy: string; now: number; pending: boolean },
): { record: CfileRecord; version: CfileVersion } | null {
  if (record?.current && record.current.sha256 === input.sha256) return null
  const seq = record?.nextKeySeq ?? 1
  const version: CfileVersion = {
    v: nextVersionNumber(record),
    keyId: `${input.keyIdSeqRef}:${seq}`,
    uri: input.uri,
    iv: input.iv,
    size: input.size,
    sha256: input.sha256,
    name: input.name,
    ...(input.note ? { note: input.note } : {}),
    updatedAt: input.now,
    updatedBy: input.updatedBy.toLowerCase(),
    ...(input.pending ? { pending: true } : {}),
  }
  const history = record?.current ? [record.current, ...(record?.history ?? [])] : (record?.history ?? [])
  return {
    record: {
      current: version,
      history: history.slice(0, CFILE_HISTORY_CAP),
      nextKeySeq: seq + 1,
      createdAt: record?.createdAt ?? input.now,
    },
    version,
  }
}

/** Plan a rollback: re-activate history version `v` as a NEW display version
 *  carrying its original keyId/iv/uri verbatim — decryptable by construction,
 *  no re-upload, no new spend. Returns null when `v` isn't in history. */
export function planRollback(
  record: CfileRecord,
  v: number,
  updatedBy: string,
  now: number,
): CfileRecord | null {
  const target = record.history.find((h) => h.v === v)
  if (!target) return null
  const revived: CfileVersion = {
    ...target,
    v: nextVersionNumber(record),
    updatedAt: now,
    updatedBy: updatedBy.toLowerCase(),
  }
  const history = record.current ? [record.current, ...record.history] : record.history
  return {
    ...record,
    current: revived,
    history: history.slice(0, CFILE_HISTORY_CAP),
  }
}
