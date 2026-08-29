import { NextRequest, NextResponse, after } from 'next/server'
import { errorResponse, upstreamError } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { consumeUserQuota } from '@/lib/userQuota'
import { isPlatformPausedFor } from '@/lib/gate'
import { isBlacklisted } from '@/lib/blacklist'
import { acquireLock } from '@/lib/redisLock'
import { redis } from '@/lib/redis'
import { readBodyBounded } from '@/lib/boundedBody'
import {
  CFILE_MAX_BYTES,
  cfileRef,
  detectCfileKind,
  encodeCfileChunks,
  isCfileVersionRestorable,
  normalizeCfileName,
  planAttach,
  planDetach,
  planRollback,
  recordStoredBytes,
  sha256Hex,
} from '@/lib/collectorFileCore'
import {
  CFILE_STORAGE_CEILING_BYTES,
  cfileLockKey,
  cfileNotifyLockKey,
  commitCfileMutation,
  getCfileAudienceCount,
  getCfileRecord,
  getCfileRecordStrict,
  getCfileStoredBytesMap,
  getDownloaderCount,
  toPublicDescriptor,
  writeCfileBlobChunks,
} from '@/lib/collectorFile'
import { parseCfileParams, requireCfileManager } from '@/lib/collectorFileGate'
import { notifyCollectorsOfUpdate, CFILE_FANOUT_CEILING } from '@/lib/collectorFileFanout'

export const runtime = 'nodejs'

/**
 * Artist-side management of an artwork's collector file
 * (COLLECTOR_DOWNLOADS_DESIGN.md §5):
 *
 *   PUT    — attach or replace (raw zip/PDF/GLB/SVG body ≤16 MiB — format
 *            detected from magic bytes, or a bounded text sniff for SVG —
 *            x-file-name header, ?note= release note, ?notify=1 to fan out)
 *   GET    — manage view (descriptor + history + downloader count + notify state)
 *   PATCH  — { action: 'rollback', v } — re-activate a history version
 *   DELETE — detach (tombstones serving; history stays artist-visible)
 *
 * Authorization is the update-uri predicate (on-chain ADMIN|METADATA via
 * canManageCfile) on a plain session — deliberately NO signed message and NO
 * pass gate, matching the closest platform-spend precedents: /api/upload
 * (50 MB JSON on session only) and update-uri (no pass gate). A
 * readPermissions outage answers 503, never a misleading 403.
 */

// One PUT at a time platform-wide: each holds ~38 MB peak (body buffer +
// base64 chunk strings). The transcode-gif MAX_CONCURRENT=1 pattern,
// check-then-increment with no await between (app/api/img discipline).
const MAX_CONCURRENT_PUTS = 1
let activePuts = 0

export async function GET(req: NextRequest) {
  // Metered like its siblings: the manager gate below costs up to two
  // readPermissions chains (4 RPC retries each) BEFORE the 403, so an
  // unmetered loop would be free RPC load.
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`cfile-manage:${ip}`, 30, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const params = parseCfileParams(req)
  if (!params) return errorResponse(400, 'Invalid collection or tokenId')
  const auth = await requireCfileManager(req, params)
  if (auth instanceof NextResponse) return auth

  let record, downloaders, audience, cooldownTtl
  try {
    ;[record, downloaders, audience, cooldownTtl] = await Promise.all([
      getCfileRecord(params.collection, params.tokenId),
      getDownloaderCount(params.collection, params.tokenId),
      getCfileAudienceCount(params.collection, params.tokenId),
      redis.ttl(cfileNotifyLockKey(cfileRef(params.collection, params.tokenId))).catch(() => -2),
    ])
  } catch (err) {
    // getCfileAudience is strictRead (a silently-empty audience would lie to
    // the notify pre-check) — map its throw to the feature's 503 shape
    // instead of a bare 500.
    console.error('[cfile-manage] read failed', err instanceof Error ? err.message : err)
    return errorResponse(503, 'Temporarily unavailable — try again shortly')
  }
  return NextResponse.json({
    file: toPublicDescriptor(record),
    history: (record?.history ?? []).map((h) => ({
      v: h.v,
      name: h.name,
      size: h.size,
      sha256: h.sha256,
      updatedAt: h.updatedAt,
      ...(h.note ? { note: h.note } : {}),
      // Bytes retained → rollback offered; older rows are record only.
      restorable: !!h.stored,
    })),
    downloaders,
    audience,
    fanoutCeiling: CFILE_FANOUT_CEILING,
    // Seconds until "notify collectors" is available again; 0 = available.
    notifyCooldownSecs: cooldownTtl > 0 ? cooldownTtl : 0,
  })
}

export async function PUT(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`cfile-put:${ip}`, 5, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const params = parseCfileParams(req)
  if (!params) return errorResponse(400, 'Invalid collection or tokenId')

  const auth = await requireCfileManager(req, params)
  if (auth instanceof NextResponse) return auth
  const caller = auth.address

  if (await isPlatformPausedFor(caller)) {
    return errorResponse(503, 'Platform is temporarily paused — try again shortly')
  }
  // Action blacklist (fails open on a Redis blip; ~15-min memo staleness is
  // the documented trade-off, lib/blacklist.ts). The collect route's pattern.
  if (await isBlacklisted(caller)) {
    return errorResponse(403, 'Not available for this account')
  }

  // Loose header filter only — the magic-byte detection below is the real
  // format gate. Empty is allowed (OS mime maps often have no entry for
  // .glb) and both clients send explicit octet-stream anyway; this just
  // bounces obviously-wrong clients (HTML forms, JSON) before the body read.
  const contentType = (req.headers.get('content-type') ?? '').toLowerCase()
  const CT_OK = ['application/octet-stream', 'application/zip', 'application/x-zip-compressed', 'application/pdf', 'model/gltf-binary', 'image/svg+xml']
  if (contentType && !CT_OK.some((t) => contentType.includes(t))) {
    return errorResponse(415, 'Send the file as application/octet-stream')
  }
  // Advisory pre-check; the bounded read below enforces on actual bytes.
  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > CFILE_MAX_BYTES) {
    return errorResponse(413, 'File too large — the limit is 16 MB')
  }
  if (!req.body) return errorResponse(400, 'Missing body')

  // The client URI-encodes the filename (header values must be Latin-1 —
  // a raw CJK/emoji name makes fetch() itself throw client-side). Decode
  // best-effort; normalize strips anything non-ASCII either way.
  const rawName = req.headers.get('x-file-name')
  let decodedName = rawName
  try {
    decodedName = rawName ? decodeURIComponent(rawName) : rawName
  } catch {
    // Malformed percent-encoding — normalize the raw value instead.
  }
  const rawNote = req.nextUrl.searchParams.get('note') ?? ''
  const note = rawNote.trim().slice(0, 140) || undefined
  const wantNotify = req.nextUrl.searchParams.get('notify') === '1'

  if (activePuts >= MAX_CONCURRENT_PUTS) {
    return errorResponse(503, 'Another upload is in progress — try again in a moment')
  }
  activePuts++
  try {
    const read = await readBodyBounded(req.body, CFILE_MAX_BYTES)
    if (read.kind === 'overflow') {
      read.reader.cancel().catch(() => {})
      return errorResponse(413, 'File too large — the limit is 16 MB')
    }
    const plaintext = read.buffer
    // Magic bytes decide the format; the claimed name/extension never does.
    const kind = detectCfileKind(plaintext)
    if (!kind) {
      return errorResponse(415, 'Not an accepted file type — upload a zip, PDF, GLB or SVG')
    }
    const name = normalizeCfileName(decodedName, kind)

    // Per-artwork mutual exclusion, acquired BEFORE the meters and the
    // chunk writes: a racing co-admin 409s without spending anything, and
    // the identical-bytes dedup below runs before any quota debits so the
    // nervous double-upload genuinely burns nothing (rev-1's lost-update
    // bug + the review's meters-before-dedup finding). TTL bounds a
    // crashed holder.
    const lock = await acquireLock(cfileLockKey(cfileRef(params.collection, params.tokenId)), 180)
    if (!lock.acquired) {
      return errorResponse(409, 'Someone else is updating this file — try again in a moment')
    }
    try {
      // STRICT read: this record's history and nextBlobSeq are the only
      // thing standing between a Redis blip and re-minting a live version's
      // blobSeq — new chunks written over bytes an older stored version
      // still points at (the degrading read here was the review's top
      // finding). A throw answers 503 below.
      let record
      try {
        record = await getCfileRecordStrict(params.collection, params.tokenId)
      } catch (err) {
        return upstreamError(503, 'Temporarily unavailable — try again shortly', err, 'cfile-put')
      }
      const sha256 = sha256Hex(plaintext)
      if (record?.current && record.current.sha256 === sha256) {
        // Identical bytes: burn nothing (no version, no meters, no storage,
        // no cooldown) — the nervous double-upload case.
        return NextResponse.json({ file: toPublicDescriptor(record), unchanged: true })
      }

      const planned = planAttach(record, {
        size: plaintext.length,
        sha256,
        kind,
        name,
        note,
        updatedBy: caller,
        now: Date.now(),
      })
      if (!planned) {
        // Only reachable if current changed under us — the lock makes this
        // effectively dead code, kept as the pure-layer guard.
        return NextResponse.json({ file: toPublicDescriptor(record), unchanged: true })
      }

      // The fail-CLOSED global storage ceiling, checked BEFORE the quota
      // debits: resident bytes are the one open-ended cost axis of
      // Redis-stored files, so a ledger-read failure refuses (503) rather
      // than waving the write through — and an artist retrying against a
      // full platform must not burn their 15/day on 507s. Cross-artwork
      // check/commit races can't happen today (MAX_CONCURRENT_PUTS = 1 in
      // a single-process deployment serializes every PUT past the slot);
      // if that slot or the pod count ever grows, the worst case is an
      // overshoot of one file per extra concurrent PUT — the ledger
      // rewrite itself stays absolute per artwork either way.
      let storedMap: Record<string, number>
      try {
        storedMap = await getCfileStoredBytesMap()
      } catch (err) {
        return upstreamError(503, 'Temporarily unavailable — try again shortly', err, 'cfile-put')
      }
      const ref = cfileRef(params.collection, params.tokenId)
      const othersBytes = Object.entries(storedMap).reduce(
        (sum, [r, b]) => (r === ref ? sum : sum + b),
        0,
      )
      if (othersBytes + recordStoredBytes(planned.record) > CFILE_STORAGE_CEILING_BYTES) {
        return errorResponse(507, 'Platform download storage is full — contact Kismet to raise it')
      }

      // Per-identity meters (fail open by platform convention), debited only
      // once the write is actually going to be attempted.
      if (!(await consumeUserQuota('cfile-upload', caller, 1))) {
        return errorResponse(429, 'Daily file-upload limit reached — try again tomorrow')
      }
      if (!(await consumeUserQuota('cfile-bytes', caller, plaintext.length))) {
        return errorResponse(429, 'Daily file-upload size limit reached — try again tomorrow')
      }

      // Chunks land with a self-expiring TTL; the commit MULTI persists them
      // with the record write, so a crash here leaves only orphans that
      // expire — never a live record pointing at half-written bytes. Race a
      // wall-clock bound so a stalled write can't pin the PUT slot (route
      // maxDuration is a no-op self-hosted, OPS_RUNBOOK.md).
      try {
        await Promise.race([
          writeCfileBlobChunks(
            params.collection,
            params.tokenId,
            planned.version.blobSeq,
            encodeCfileChunks(plaintext),
          ),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('chunk write timeout')), 60_000),
          ),
        ])
      } catch (err) {
        return upstreamError(504, 'Storage write timed out — try again', err, 'cfile-put')
      }
      try {
        await commitCfileMutation(params.collection, params.tokenId, planned.record, {
          persistBlob: { blobSeq: planned.version.blobSeq, chunks: planned.version.chunks },
          prune: planned.prune,
        })
      } catch (err) {
        // The MULTI is atomic server-side; a network throw leaves state
        // unknown but every retry is safe — applied: the re-PUT dedups to
        // `unchanged`; not applied: the orphan TTL cleans the chunks.
        return upstreamError(503, 'Temporarily unavailable — try again shortly', err, 'cfile-put')
      }

      if (wantNotify) {
        after(() =>
          notifyCollectorsOfUpdate({
            collection: params.collection,
            tokenId: params.tokenId,
            actor: caller,
            note,
          }).catch(() => {}),
        )
      }
      return NextResponse.json({
        file: toPublicDescriptor(planned.record),
        notifyQueued: wantNotify,
      })
    } finally {
      await lock.release()
    }
  } finally {
    activePuts--
  }
}

export async function PATCH(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`cfile-manage:${ip}`, 20, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const params = parseCfileParams(req)
  if (!params) return errorResponse(400, 'Invalid collection or tokenId')
  const auth = await requireCfileManager(req, params)
  if (auth instanceof NextResponse) return auth

  const body = (await req.json().catch(() => null)) as { action?: string; v?: number } | null
  if (body?.action !== 'rollback' || typeof body.v !== 'number') {
    return errorResponse(400, 'Unsupported action')
  }

  const lock = await acquireLock(cfileLockKey(cfileRef(params.collection, params.tokenId)), 60)
  if (!lock.acquired) return errorResponse(409, 'Someone else is updating this file — try again')
  try {
    // Strict read, same rationale as PUT: a degraded null here would 404 a
    // real record (harmless) but must never be written back over.
    let record
    try {
      record = await getCfileRecordStrict(params.collection, params.tokenId)
    } catch (err) {
      return upstreamError(503, 'Temporarily unavailable — try again shortly', err, 'cfile-patch')
    }
    if (!record) return errorResponse(404, 'No file attached')
    if (!record.history.some((h) => h.v === body.v)) {
      return errorResponse(404, 'That version is not in the history')
    }
    if (!isCfileVersionRestorable(record, body.v)) {
      // The row exists but its bytes left the retention window (or a detach
      // freed them) — an honest refusal beats a silent 404.
      return errorResponse(409, "That version's file is no longer stored — upload it again instead")
    }
    // Rollback re-points at the version's ORIGINAL blobSeq — the bytes
    // already exist, no re-upload; provably prunes nothing (§4.2).
    const next = planRollback(record, body.v, auth.address, Date.now())
    if (!next) return errorResponse(409, "That version's file is no longer stored — upload it again instead")
    try {
      await commitCfileMutation(params.collection, params.tokenId, next.record, { prune: next.prune })
    } catch (err) {
      return upstreamError(503, 'Temporarily unavailable — try again shortly', err, 'cfile-patch')
    }
    return NextResponse.json({ file: toPublicDescriptor(next.record) })
  } finally {
    await lock.release()
  }
}

export async function DELETE(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`cfile-manage:${ip}`, 20, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const params = parseCfileParams(req)
  if (!params) return errorResponse(400, 'Invalid collection or tokenId')
  const auth = await requireCfileManager(req, params)
  if (auth instanceof NextResponse) return auth

  const lock = await acquireLock(cfileLockKey(cfileRef(params.collection, params.tokenId)), 60)
  if (!lock.acquired) return errorResponse(409, 'Someone else is updating this file — try again')
  try {
    // Strict read: a degraded null would make this DELETE silently no-op OR,
    // worse, a later code change could write over a blip-nulled record.
    let record
    try {
      record = await getCfileRecordStrict(params.collection, params.tokenId)
    } catch (err) {
      return upstreamError(503, 'Temporarily unavailable — try again shortly', err, 'cfile-delete')
    }
    if (!record?.current) return NextResponse.json({ file: null })
    // Real deletion — the point of the Redis pivot: the chunk keys are
    // freed in the same commit, storage returns to the ledger, and history
    // rows remain as the artist's record (all non-restorable).
    const planned = planDetach(record)
    try {
      await commitCfileMutation(params.collection, params.tokenId, planned.record, {
        prune: planned.prune,
      })
    } catch (err) {
      return upstreamError(503, 'Temporarily unavailable — try again shortly', err, 'cfile-delete')
    }
    return NextResponse.json({ file: null })
  } finally {
    await lock.release()
  }
}
