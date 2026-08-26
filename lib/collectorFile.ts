import 'server-only'
import { redis } from './redis'
import { strictRead, safeRead } from './redisRead'
import { acquireLock } from './redisLock'
import { randomHex } from './random'
import { readBodyBounded } from './boundedBody'
import { gatewayUrls } from './arweave/gateways'
import {
  CFILE_MAX_BYTES,
  CFILE_TAG_BYTES,
  CFILE_IV_BYTES,
  cfileRef,
  type CfileRecord,
  type CfileVersion,
} from './collectorFileCore'
import type { CfilePublic } from './collectorFileTypes'

/**
 * Redis model + gate plumbing for collector files (COLLECTOR_DOWNLOADS_DESIGN.md).
 * The pure crypto/planning core lives in lib/collectorFileCore (verify-pinned);
 * this module owns the keys, the fail-closed reads on the gated path, the
 * audience/erasure indexes, tickets, grace markers, the kill-switch, and the
 * hardened ciphertext fetch. Routes own auth, rate limits, and concurrency.
 *
 * Key inventory (all kismetart:, all per-artwork keys canonicalized via
 * cfileRef — lowercased collection + minimal-decimal tokenId):
 *   cfile:<ref>              STR JSON CfileRecord            (no TTL)
 *   cfile-dl:<ref>           HASH addr → last downloaded v   (no TTL)
 *   collectors:<ref>         ZSET addr, score=first-seen ms  (no TTL)
 *   cfile-refs:<addr>        SET  "<ref>"                    (no TTL; erasure index)
 *   cfile-grace:<ref>:<addr> STR '1'                         (EX 900)
 *   cfile-ticket:<token>     STR JSON {ref,addr,v,name}      (EX 300/1800, single-use)
 *   cfile-lock:<ref>         SET NX (lib/redisLock)          (EX 180)
 *   cfile-notify-lock:<ref>  SET NX — IS the 24h cooldown    (EX 86400)
 *   cfile-blocked            SET  "<ref>" — admin kill-switch, checked on DOWNLOAD
 *   cfile-global-bytes:<day> STR  INCRBY meter — fail-CLOSED platform ceiling
 */

const keyRecord = (ref: string) => `kismetart:cfile:${ref}`
const keyDl = (ref: string) => `kismetart:cfile-dl:${ref}`
const keyCollectors = (ref: string) => `kismetart:collectors:${ref}`
const keyRefs = (addr: string) => `kismetart:cfile-refs:${addr.toLowerCase()}`
const keyGrace = (ref: string, addr: string) => `kismetart:cfile-grace:${ref}:${addr.toLowerCase()}`
const keyTicket = (token: string) => `kismetart:cfile-ticket:${token}`
export const cfileLockKey = (ref: string) => `kismetart:cfile-lock:${ref}`
export const cfileNotifyLockKey = (ref: string) => `kismetart:cfile-notify-lock:${ref}`
const KEY_BLOCKED = 'kismetart:cfile-blocked'
const keyGlobalBytes = (day: string) => `kismetart:cfile-global-bytes:${day}`

export const CFILE_GRACE_TTL_SECS = 15 * 60
export const CFILE_TICKET_TTL_SECS = 5 * 60
export const CFILE_SHARE_TICKET_TTL_SECS = 30 * 60
export const CFILE_NOTIFY_COOLDOWN_SECS = 24 * 60 * 60

export function getCfileMasterKey(): string {
  const key = process.env.COLLECTOR_FILE_MASTER_KEY
  if (!key) throw new Error('COLLECTOR_FILE_MASTER_KEY not configured')
  return key
}

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

export async function setCfileRecord(collection: string, tokenId: string, record: CfileRecord): Promise<void> {
  await redis.set(keyRecord(cfileRef(collection, tokenId)), JSON.stringify(record))
}

// What everyone may see: existence + display facts, never uri/iv/keyId.
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
    ...(c.pending ? { pending: true } : {}),
  }
}

/** Clear a version's `pending` flag once a gateway has served it. Takes the
 *  same per-artwork lock the PUT/PATCH/DELETE writers hold — an unlocked
 *  read-modify-write here could clobber a concurrent replace (losing the paid
 *  new version AND regressing nextKeySeq into keyId reuse). Best-effort: if
 *  the lock is busy or the read fails, skip — the flag clears on a later
 *  serve. */
export async function markCfileVersionServed(collection: string, tokenId: string, keyId: string): Promise<void> {
  const lock = await acquireLock(cfileLockKey(cfileRef(collection, tokenId)), 30)
  if (!lock.acquired) return
  try {
    const record = await getCfileRecord(collection, tokenId)
    if (!record) return
    let changed = false
    const clear = (v: CfileVersion): CfileVersion => {
      if (v.keyId === keyId && v.pending) {
        changed = true
        const { pending: _p, ...rest } = v
        return rest
      }
      return v
    }
    const next: CfileRecord = {
      ...record,
      current: record.current ? clear(record.current) : null,
      history: record.history.map(clear),
    }
    if (changed) await setCfileRecord(collection, tokenId, next)
  } finally {
    await lock.release()
  }
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
  const [collectors, downloaders] = await Promise.all([
    redis.zrange(keyCollectors(ref), 0, -1) as Promise<string[]>,
    redis.hkeys(keyDl(ref)) as Promise<string[]>,
  ])
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
  v: number
  name: string
}

/**
 * Single-use capability URL token for the actual byte transfer. The gate runs
 * at MINT time (session/signature + live balance); the download redeems the
 * token with no auth of its own — which is what lets a Mini App hand the URL
 * to the device browser via sdk.actions.openUrl, where no session exists
 * (design §5.1 path 4). 256-bit token, short TTL, deleted on first use.
 */
export async function mintCfileTicket(
  collection: string,
  tokenId: string,
  address: string,
  v: number,
  name: string,
  opts: { share?: boolean } = {},
): Promise<string> {
  const token = randomHex(32)
  const ticket: CfileTicket = { ref: cfileRef(collection, tokenId), addr: address.toLowerCase(), v, name }
  await redis.set(keyTicket(token), JSON.stringify(ticket), {
    ex: opts.share ? CFILE_SHARE_TICKET_TTL_SECS : CFILE_TICKET_TTL_SECS,
  })
  return token
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
  if (!raw) return null
  try {
    return typeof raw === 'string' ? (JSON.parse(raw) as CfileTicket) : (raw as CfileTicket)
  } catch {
    return null
  }
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

// ---------------------------------------------------------------------------
// Fail-CLOSED platform spend ceiling
// ---------------------------------------------------------------------------

/** Default 512 MiB/day of PLAINTEXT bytes across all identities. */
const PLATFORM_DAILY_BYTES = Number(process.env.CFILE_PLATFORM_DAILY_BYTES ?? 512 * 1024 * 1024)

const CEILING_LUA = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
local n = tonumber(ARGV[1])
if cur + n > tonumber(ARGV[2]) then return 0 end
local new = redis.call('INCRBY', KEYS[1], n)
if new == n then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
return 1
`

/**
 * Platform-wide day ceiling on ciphertext uploads — deliberately the INVERSE
 * failure posture of consumeUserQuota: this is the only backstop on permanent
 * Arweave spend (PLATFORM_SIGN_DAILY_CAP never covered the server-JWK path,
 * and the per-identity quota both fails open and Sybil-multiplies), so a
 * Redis failure DENIES. Precedent for a platform-wide cap on this upload
 * helper's caller: PLATFORM_MINT_DAILY_CAP in app/api/agent/prepare-mint.
 */
export async function consumeCfilePlatformBytes(bytes: number): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  try {
    const raw = await redis.eval(
      CEILING_LUA,
      [keyGlobalBytes(day)],
      [bytes, PLATFORM_DAILY_BYTES, 25 * 60 * 60],
    )
    return raw === 1 || raw === '1'
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Hardened ciphertext fetch (the /api/img discipline, scoped down)
// ---------------------------------------------------------------------------

// Sealed size ceiling: plaintext cap + IV + tag (GCM adds no other overhead).
const SEALED_MAX_BYTES = CFILE_MAX_BYTES + CFILE_IV_BYTES + CFILE_TAG_BYTES

const FETCH_TIMEOUT_MS = 30_000

// Failed-read memo per URI: an arweave.net edge dying mid-body must cost one
// probe per minute, not one ~sealed-size re-read per collector click
// (app/api/img's doomed-asset memo, scoped to this route's only upstream).
const FAILED_FETCH_MEMO_MS = 60_000
const failedFetch = new Map<string, number>()

function memoFailed(uri: string): void {
  failedFetch.set(uri, Date.now())
  // Bound the memo — this is a tiny hot-set cache, not a registry.
  if (failedFetch.size > 200) {
    const oldest = [...failedFetch.entries()].sort((a, b) => a[1] - b[1])[0]
    if (oldest) failedFetch.delete(oldest[0])
  }
}

export class CfileFetchError extends Error {
  constructor(
    message: string,
    /** true → 503-shaped (upstream/transient); false → data problem (500). */
    readonly transient: boolean,
  ) {
    super(message)
    this.name = 'CfileFetchError'
  }
}

/** Fetch the sealed bytes for `uri` (ar://…), bounded on actual bytes. */
export async function fetchSealedCfile(uri: string): Promise<Buffer> {
  const memo = failedFetch.get(uri)
  if (memo && Date.now() - memo < FAILED_FETCH_MEMO_MS) {
    throw new CfileFetchError('upstream recently failed for this file', true)
  }
  const urls = gatewayUrls(uri)
  if (urls.length === 0) throw new CfileFetchError('no gateway for uri', false)
  let res: Response
  try {
    res = await fetch(urls[0], { cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (err) {
    memoFailed(uri)
    throw new CfileFetchError(err instanceof Error ? err.message : 'gateway unreachable', true)
  }
  if (!res.ok || !res.body) {
    // 404 during the propagation window is transient; other statuses too —
    // the memo keeps repeats cheap either way.
    memoFailed(uri)
    throw new CfileFetchError(`gateway ${res.status}`, true)
  }
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > SEALED_MAX_BYTES) {
    res.body.cancel().catch(() => {})
    throw new CfileFetchError('sealed payload exceeds cap', false)
  }
  const read = await readBodyBounded(res.body, SEALED_MAX_BYTES)
  if (read.kind === 'overflow') {
    read.reader.cancel().catch(() => {})
    throw new CfileFetchError('sealed payload exceeds cap (actual bytes)', false)
  }
  return read.buffer
}
