import 'server-only'
import { Redis } from '@upstash/redis'
import { redis } from './redis'
import { strictRead, safeRead } from './redisRead'
import { randomHex } from './random'
import {
  CFILE_MAX_BYTES,
  cfileChunkCount,
  cfileRef,
  decodeCfileChunks,
  recordStoredBytes,
  type CfileBlobRef,
  type CfileRecord,
} from './collectorFileCore'
import type { CfilePublic } from './collectorFileTypes'

/**
 * Redis model + gate plumbing for collector files (COLLECTOR_DOWNLOADS_DESIGN.md,
 * "Storage pivot"). The pure chunk-codec/planning core lives in
 * lib/collectorFileCore (verify-pinned); this module owns the keys, the
 * fail-closed reads on the gated path, the chunked blob store, the
 * audience/erasure indexes, tickets, grace markers, the kill-switch, and the
 * global storage ceiling. Routes own auth, rate limits, and concurrency.
 *
 * Key inventory (all kismetart:, all per-artwork keys canonicalized via
 * cfileRef — lowercased collection + minimal-decimal tokenId):
 *   cfile:<ref>              STR JSON CfileRecord            (no TTL)
 *   cfile-blob:<ref>:<seq>:<i> STR 'b'+base64 chunk — written EX 3600,
 *                            PERSISTed by the commit MULTI (a crashed PUT
 *                            self-heals: unreferenced chunks expire)
 *   cfile-bytes              HASH ref → resident stored bytes (absolute,
 *                            rewritten per mutation — the ceiling's ledger)
 *   cfile-dl:<ref>           HASH addr → last downloaded v   (no TTL)
 *   collectors:<ref>         ZSET addr, score=first-seen ms  (no TTL)
 *   cfile-refs:<addr>        SET  "<ref>"                    (no TTL; erasure index)
 *   cfile-grace:<ref>:<addr> STR '1'                         (EX 900)
 *   cfile-ticket:<token>     STR JSON {ref,addr,share?}      (EX 300/1800, single-use)
 *   cfile-lock:<ref>         SET NX (lib/redisLock)          (EX 180)
 *   cfile-notify-lock:<ref>  SET NX — IS the 24h cooldown    (EX 86400)
 *   cfile-blocked            SET  "<ref>" — admin kill-switch, checked on DOWNLOAD
 */

const keyRecord = (ref: string) => `kismetart:cfile:${ref}`
const keyBlob = (ref: string, seq: number, i: number) => `kismetart:cfile-blob:${ref}:${seq}:${i}`
const KEY_BYTES = 'kismetart:cfile-bytes'
const keyDl = (ref: string) => `kismetart:cfile-dl:${ref}`
const keyCollectors = (ref: string) => `kismetart:collectors:${ref}`
const keyRefs = (addr: string) => `kismetart:cfile-refs:${addr.toLowerCase()}`
const keyGrace = (ref: string, addr: string) => `kismetart:cfile-grace:${ref}:${addr.toLowerCase()}`
const keyTicket = (token: string) => `kismetart:cfile-ticket:${token}`
export const cfileLockKey = (ref: string) => `kismetart:cfile-lock:${ref}`
export const cfileNotifyLockKey = (ref: string) => `kismetart:cfile-notify-lock:${ref}`
const KEY_BLOCKED = 'kismetart:cfile-blocked'

const CFILE_GRACE_TTL_SECS = 15 * 60
export const CFILE_TICKET_TTL_SECS = 5 * 60
export const CFILE_SHARE_TICKET_TTL_SECS = 30 * 60
export const CFILE_NOTIFY_COOLDOWN_SECS = 24 * 60 * 60
const CFILE_BLOB_ORPHAN_TTL_SECS = 60 * 60

/** Global resident-bytes ceiling across every artwork's stored versions.
 *  Keeps the whole feature (worst case) comfortably inside Upstash's first
 *  free storage GB next to the ~sub-MB rest of the database; ops raises it
 *  by env when adoption asks (storage past 1 GB bills $0.25/GB-mo — a cost
 *  dial, not a cliff). */
export const CFILE_STORAGE_CEILING_BYTES = Number(
  process.env.CFILE_STORAGE_CEILING_BYTES ?? 512 * 1024 * 1024,
)

// ---------------------------------------------------------------------------
// Record CRUD
// ---------------------------------------------------------------------------

function parseRecord(raw: string | CfileRecord | null): CfileRecord | null {
  if (!raw) return null
  try {
    return typeof raw === 'string' ? (JSON.parse(raw) as CfileRecord) : raw
  } catch {
    return null
  }
}

/** Gated-path read: throws on Redis failure (strictRead — the hiddenMoments
 *  posture) so an outage 503s instead of serving/denying on garbage. */
export async function getCfileRecordStrict(collection: string, tokenId: string): Promise<CfileRecord | null> {
  const ref = cfileRef(collection, tokenId)
  return parseRecord(await strictRead('cfile-record', () => redis.get<string | CfileRecord>(keyRecord(ref))))
}

/** Display-path read: degrades to null (page assembly must not 500 on a blip). */
export async function getCfileRecord(collection: string, tokenId: string): Promise<CfileRecord | null> {
  const ref = cfileRef(collection, tokenId)
  return parseRecord(await safeRead('cfile-record', () => redis.get<string | CfileRecord>(keyRecord(ref)), null))
}

/** SSR read that keeps "no file" and "Redis blip" DISTINGUISHABLE:
 *  null = known-absent (the card can skip its status fetch entirely),
 *  undefined = unknown (the card's own fetch recovers). Collapsing a blip
 *  into null would make an attached file's card silently vanish for that
 *  page view with no client-side recovery. */
export async function getCfileRecordForSSR(collection: string, tokenId: string): Promise<CfileRecord | null | undefined> {
  try {
    const ref = cfileRef(collection, tokenId)
    return parseRecord(await strictRead('cfile-record-ssr', () => redis.get<string | CfileRecord>(keyRecord(ref))))
  } catch {
    return undefined
  }
}

// What everyone may see: existence + display facts, never storage internals.
// Declared in lib/collectorFileTypes (client-safe) — this module is
// server-only and the UI needs the shape.
export type { CfilePublic } from './collectorFileTypes'

export function toPublicDescriptor(record: CfileRecord | null): CfilePublic | null {
  const c = record?.current
  if (!c) return null
  return {
    name: c.name,
    size: c.size,
    sha256: c.sha256,
    v: c.v,
    updatedAt: c.updatedAt,
    ...(c.note ? { note: c.note } : {}),
  }
}

// ---------------------------------------------------------------------------
// Chunked blob store (the byte path)
// ---------------------------------------------------------------------------

/** Data problem inside the store (missing/malformed chunk, size mismatch) —
 *  routes answer 500, never bytes. A strictRead throw (Redis outage) stays
 *  its own error and maps to 503. */
export class CfileDataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CfileDataError'
  }
}

/**
 * Dedicated client for chunk I/O, auto-pipelining OFF. The shared client's
 * auto-pipeline is CLIENT-GLOBAL with a two-microtask flush window (SDK
 * AutoPipelineExecutor; `get`/`set` are not in its EXCLUDE list), so two
 * CONCURRENT requests' chunk commands landing in the same tick would be
 * batched into ONE REST call — two ~5.4 MB replies in one response breaches
 * Upstash's 10 MB cap. A non-pipelining client sends one HTTP request per
 * command unconditionally, which also makes parallel chunk I/O safe (each
 * request/response carries a single chunk). automaticDeserialization is off
 * too: chunks come back as raw strings, no JSON.parse pass at all (the 'b'
 * prefix stays as defense-in-depth for anything else that reads these keys).
 */
const blobRedis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL ?? 'https://placeholder.upstash.io',
  token: process.env.UPSTASH_REDIS_REST_TOKEN ?? 'placeholder',
  enableAutoPipelining: false,
  automaticDeserialization: false,
  // lib/redis.ts's bounded-retry rationale applies unchanged.
  retry: { retries: 2, backoff: (n) => 2 ** n * 50 + Math.floor(Math.random() * 50) },
})

/**
 * Write a version's chunks (parallel — one bounded HTTP request each on the
 * dedicated client). Chunks land with a short TTL; the commit MULTI
 * PERSISTs them together with the record write, so a crash between the two
 * leaves only self-expiring orphans — never a record pointing at missing
 * bytes.
 */
export async function writeCfileBlobChunks(
  collection: string,
  tokenId: string,
  blobSeq: number,
  chunks: string[],
): Promise<void> {
  const ref = cfileRef(collection, tokenId)
  await Promise.all(
    chunks.map((chunk, i) =>
      blobRedis.set(keyBlob(ref, blobSeq, i), chunk, { ex: CFILE_BLOB_ORPHAN_TTL_SECS }),
    ),
  )
}

/** Read + reassemble a version's bytes (parallel single-chunk requests on
 *  the dedicated client). strictRead per chunk (outage → throw → 503);
 *  a missing or malformed chunk is a CfileDataError (→ 500). */
export async function readCfileBlob(
  collection: string,
  tokenId: string,
  version: { blobSeq: number; chunks: number; size: number },
): Promise<Buffer> {
  // Records are only ever written by this module, but they ARE mutable data:
  // bound the loop by what a legal record can hold so a corrupted/hand-edited
  // record degrades to a 500, not an unbounded fan-out of chunk reads.
  if (
    !Number.isInteger(version.chunks) ||
    version.chunks < 1 ||
    version.chunks > cfileChunkCount(CFILE_MAX_BYTES) ||
    !Number.isInteger(version.size) ||
    version.size < 1 ||
    version.size > CFILE_MAX_BYTES
  ) {
    throw new CfileDataError(`implausible version shape (chunks=${version.chunks}, size=${version.size})`)
  }
  const ref = cfileRef(collection, tokenId)
  const chunks = await Promise.all(
    Array.from({ length: version.chunks }, (_, i) =>
      strictRead('cfile-blob', () => blobRedis.get<string>(keyBlob(ref, version.blobSeq, i))),
    ),
  )
  try {
    return decodeCfileChunks(
      chunks.map((raw, i) => {
        if (typeof raw !== 'string') throw new CfileDataError(`chunk ${i} of blob ${version.blobSeq} missing`)
        return raw
      }),
      version.size,
    )
  } catch (err) {
    if (err instanceof CfileDataError) throw err
    throw new CfileDataError(err instanceof Error ? err.message : 'chunk decode failed')
  }
}

/**
 * Commit a planned mutation atomically: PERSIST the new version's chunks
 * (clearing their orphan TTL), write the record, rewrite this artwork's
 * absolute entry in the storage ledger, and delete pruned blobs' keys — one
 * MULTI, so no interleaving of these ever leaves the ledger or the flags
 * disagreeing with the keys. Callers hold the per-artwork lock.
 */
export async function commitCfileMutation(
  collection: string,
  tokenId: string,
  record: CfileRecord,
  opts: { persistBlob?: CfileBlobRef; prune?: CfileBlobRef[] } = {},
): Promise<void> {
  const ref = cfileRef(collection, tokenId)
  const bytes = recordStoredBytes(record)
  const tx = redis.multi()
  if (opts.persistBlob) {
    for (let i = 0; i < opts.persistBlob.chunks; i++) tx.persist(keyBlob(ref, opts.persistBlob.blobSeq, i))
  }
  tx.set(keyRecord(ref), JSON.stringify(record))
  if (bytes > 0) tx.hset(KEY_BYTES, { [ref]: bytes })
  else tx.hdel(KEY_BYTES, ref)
  for (const p of opts.prune ?? []) {
    for (let i = 0; i < p.chunks; i++) tx.del(keyBlob(ref, p.blobSeq, i))
  }
  await tx.exec()
}

/** The storage ledger, ref → resident bytes. strictRead: the PUT ceiling
 *  check is the only backstop on resident growth, so a Redis blip refuses
 *  (503) rather than waving an upload through unmetered. */
export async function getCfileStoredBytesMap(): Promise<Record<string, number>> {
  const raw = await strictRead('cfile-bytes', () => redis.hgetall<Record<string, number | string>>(KEY_BYTES))
  const out: Record<string, number> = {}
  for (const [ref, v] of Object.entries(raw ?? {})) {
    const n = Number(v)
    if (Number.isFinite(n)) out[ref] = n
  }
  return out
}

// ---------------------------------------------------------------------------
// Audience + erasure indexes (mirror-written where a collector becomes known)
// ---------------------------------------------------------------------------

/**
 * Record `address` as a known collector of the artwork, plus the per-address
 * reverse ref the admin erase needs (design §4.3 — without it a hard-erased
 * secondary buyer's address would be unreachable inside per-artwork keys).
 * Best-effort by contract: call sites already treat their forward-index write
 * the same way.
 */
export async function recordCollectorAudience(
  address: string,
  collection: string,
  tokenId: string,
  timestamp: number = Date.now(),
): Promise<void> {
  const ref = cfileRef(collection, tokenId)
  const addr = address.toLowerCase()
  await Promise.all([
    // NX: first-seen wins — re-collects must not reorder the audience.
    redis.zadd(keyCollectors(ref), { nx: true }, { score: timestamp, member: addr }),
    redis.sadd(keyRefs(addr), ref),
  ])
}

/** Fanout audience: everyone the index knows ∪ everyone who ever downloaded
 *  (catches holders the event-sourced index missed once they've interacted). */
export async function getCfileAudience(collection: string, tokenId: string): Promise<string[]> {
  const ref = cfileRef(collection, tokenId)
  // strictRead: callers are the artist-facing manage/notify routes (which map
  // a throw to their 503 convention) and the fanout (whose catch aborts
  // without consuming the cooldown) — a silently-empty audience would read
  // as "nobody to notify" and burn the artist's day.
  const [collectors, downloaders] = await strictRead('cfile-audience', () =>
    Promise.all([
      redis.zrange(keyCollectors(ref), 0, -1) as Promise<string[]>,
      redis.hkeys(keyDl(ref)) as Promise<string[]>,
    ]),
  )
  return Array.from(new Set<string>([...collectors.map((a) => a.toLowerCase()), ...downloaders.map((a) => a.toLowerCase())]))
}

/** Audience size for pre-checks and the manage view — the SAME union the
 *  fanout gates on, so a near-ceiling edition can't pass a ZCARD-only
 *  pre-check and then be silently refused inside after(). */
export async function getCfileAudienceCount(collection: string, tokenId: string): Promise<number> {
  return (await getCfileAudience(collection, tokenId)).length
}

/**
 * Admin profile-erase integration: remove `address` from every per-artwork
 * structure it appears in, located via the reverse refs plus the caller-
 * supplied collected members (read BEFORE deleteCollected runs — design
 * §4.3). Idempotent; safe to re-run.
 */
export async function eraseCfileAddressData(address: string, collectedMembers: string[]): Promise<void> {
  const addr = address.toLowerCase()
  const refs = new Set<string>(collectedMembers.map((m) => m.toLowerCase()))
  try {
    const stored = (await redis.smembers(keyRefs(addr))) as string[]
    for (const r of stored) refs.add(r.toLowerCase())
  } catch {
    // Redis blip — proceed with what the collected list gave us; the admin
    // can re-run the erase (the route's documented recovery for every purge).
  }
  // Per-ref removals FIRST; the refs key — the only way a re-run can find
  // these memberships — is deleted only when every removal succeeded.
  // Deleting it alongside a failed zrem would strand the erased address in
  // an audience set forever, unreachable by the documented re-run recovery.
  const results = await Promise.allSettled(
    [...refs].flatMap((ref) => [
      redis.zrem(keyCollectors(ref), addr),
      redis.hdel(keyDl(ref), addr),
    ]),
  )
  if (results.every((r) => r.status === 'fulfilled')) {
    await redis.del(keyRefs(addr)).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Download bookkeeping, grace, tickets, kill-switch
// ---------------------------------------------------------------------------

export async function recordCfileDownload(collection: string, tokenId: string, address: string, v: number): Promise<void> {
  const ref = cfileRef(collection, tokenId)
  await redis.hset(keyDl(ref), { [address.toLowerCase()]: v })
}

/** Last version this wallet downloaded (null = never) — powers the
 *  "update available" badge. Degrades to null. */
export async function getDownloadedVersion(collection: string, tokenId: string, address: string): Promise<number | null> {
  const ref = cfileRef(collection, tokenId)
  const v = await safeRead('cfile-dl-get', () => redis.hget<number | string>(keyDl(ref), address.toLowerCase()), null)
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Unique wallets that ever downloaded (HLEN counts people, not downloads —
 *  the manage panel labels it accordingly). */
export async function getDownloaderCount(collection: string, tokenId: string): Promise<number> {
  const ref = cfileRef(collection, tokenId)
  return (await safeRead('cfile-dl-count', () => redis.hlen(keyDl(ref)), 0)) ?? 0
}

/**
 * Freshness grace: /api/collect (and the airdrop / listing-fill verified
 * paths) receipt-verified this exact (recipient, artwork) seconds ago, so the
 * download gate accepts the marker while the server RPC catches up — without
 * it the flagship post-collect "download ready" click 403s during read-replica
 * lag (the exact lag useDirectCollect's own record retries document).
 */
export async function grantDownloadGrace(collection: string, tokenId: string, address: string): Promise<void> {
  const ref = cfileRef(collection, tokenId)
  await redis.set(keyGrace(ref, address), '1', { ex: CFILE_GRACE_TTL_SECS })
}

export async function hasDownloadGrace(collection: string, tokenId: string, address: string): Promise<boolean> {
  const ref = cfileRef(collection, tokenId)
  return (await safeRead('cfile-grace', () => redis.get<string | number>(keyGrace(ref, address)), null)) != null
}

export interface CfileTicket {
  ref: string
  addr: string
  /** Copy-link variant: the download route answers its bare GET with a
   *  confirmation page instead of bytes, so unfurl bots and URL-bar
   *  prefetchers can't redeem it (design §5.1). */
  share?: true
}

/**
 * Single-use capability URL token for the actual byte transfer. The gate runs
 * at MINT time (session/signature + live balance); the download redeems the
 * token with no auth of its own — which is what lets a Mini App hand the URL
 * to the device browser via sdk.actions.openUrl, where no session exists
 * (design §5.1 path 4). 256-bit token, short TTL, deleted on first use.
 * Deliberately carries NO version or name: a ticket authorizes `addr` to
 * download this artwork's CURRENT file once — redemption re-reads the
 * record, so a replace between mint and redeem serves the new version.
 */
export async function mintCfileTicket(
  collection: string,
  tokenId: string,
  address: string,
  opts: { share?: boolean } = {},
): Promise<string> {
  const token = randomHex(32)
  const ticket: CfileTicket = {
    ref: cfileRef(collection, tokenId),
    addr: address.toLowerCase(),
    ...(opts.share ? { share: true as const } : {}),
  }
  await redis.set(keyTicket(token), JSON.stringify(ticket), {
    ex: opts.share ? CFILE_SHARE_TICKET_TTL_SECS : CFILE_TICKET_TTL_SECS,
  })
  return token
}

function parseTicket(raw: unknown): CfileTicket | null {
  if (!raw) return null
  try {
    return typeof raw === 'string' ? (JSON.parse(raw) as CfileTicket) : (raw as CfileTicket)
  } catch {
    return null
  }
}

/** Validate a ticket WITHOUT consuming it. The download route peeks first and
 *  consumes only after the bytes are read and integrity-checked, so a Redis
 *  blip (or a busy 503) never burns the single-use ticket — the same URL
 *  simply works on retry. */
export async function peekCfileTicket(token: string): Promise<CfileTicket | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null
  return parseTicket(await strictRead('cfile-ticket-peek', () => redis.get(keyTicket(token))))
}

// GET+DEL in one script so two concurrent redemptions can't both pass —
// the loser reads nil. (GETDEL exists upstream but eval keeps us inside the
// commands the whole codebase already uses.)
const CONSUME_TICKET_LUA = `
local v = redis.call('GET', KEYS[1])
if v then redis.call('DEL', KEYS[1]) end
return v
`

export async function consumeCfileTicket(token: string): Promise<CfileTicket | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null
  const raw = await strictRead('cfile-ticket', () =>
    redis.eval(CONSUME_TICKET_LUA, [keyTicket(token)], []),
  )
  return parseTicket(raw)
}

/** Admin kill-switch, checked on DOWNLOAD (not just attach) so moderation can
 *  stop an already-attached file. Fails closed via strictRead on the gated
 *  path. Members are canonical refs. */
export async function isCfileBlocked(collection: string, tokenId: string): Promise<boolean> {
  const ref = cfileRef(collection, tokenId)
  return (await strictRead('cfile-blocked', () => redis.sismember(KEY_BLOCKED, ref))) === 1
}

export async function setCfileBlocked(collection: string, tokenId: string, blocked: boolean): Promise<void> {
  const ref = cfileRef(collection, tokenId)
  if (blocked) await redis.sadd(KEY_BLOCKED, ref)
  else await redis.srem(KEY_BLOCKED, ref)
}

