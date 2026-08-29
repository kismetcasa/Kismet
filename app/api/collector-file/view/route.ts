import { NextRequest, NextResponse } from 'next/server'
import { errorResponse, upstreamError } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionAddress } from '@/lib/session'
import { consumeUserQuota } from '@/lib/userQuota'
import { CFILE_KINDS, isViewableCfileKind, sha256Hex } from '@/lib/collectorFileCore'
import {
  CfileDataError,
  getCfileRecordStrict,
  isCfileBlocked,
  readCfileBlob,
} from '@/lib/collectorFile'
import { authorizeBySession, parseCfileParams } from '@/lib/collectorFileGate'

export const runtime = 'nodejs'

/**
 * In-page VIEW of a collector file (design "Format extension"): the same
 * gated bytes the download route serves, shaped for consumption by a
 * renderer instead of by a save dialog. Deliberately a separate route
 * rather than a mode flag on the download path, because four of its
 * properties are inverted:
 *
 *   1. SESSION ONLY — no tickets. A ticket exists so a Mini App webview can
 *      hand a URL to the device browser for SAVING; viewing happens inside
 *      our own page, where the patched window.fetch carries the Quick Auth
 *      JWT (FarcasterProvider) or the cookie. Accepting tickets here would
 *      let a share link be redeemed by something that never renders it.
 *   2. NOT a download — this never calls recordCfileDownload. Seeing a file
 *      is not having it: stamping the marker would tell a collector holding
 *      v2 on disk that they are current on v3, and would count lookers in
 *      the artist's unique-downloader stat.
 *   3. CACHEABLE — `private, max-age` (a cached copy is a downloaded copy
 *      anyway; the file already reached the browser). This is what keeps
 *      repeat views off the metered Upstash bandwidth and off the
 *      reassembly slot. The client appends the version it knows as `?v=`
 *      purely as a CACHE KEY, so a replace can never be masked by a stale
 *      cached body; this route ignores it and always serves `current`.
 *      The cost, accepted: a collector who sells the edition (or a file
 *      blocked by an admin) keeps browser-cached viewing for the window —
 *      bytes they had already received.
 *   4. VIEWABLE KINDS ONLY — glb/svg. A zip or PDF here is a 415, not a
 *      quiet byte transfer through a route with no attachment semantics.
 *
 * Everything else — the two-path collector gate, the kill-switch, strict
 * fail-closed reads, the integrity check — is identical to the download
 * route, because it is the same gate on the same bytes.
 *
 * SVG SAFETY: served `attachment` + `nosniff` exactly like a download, even
 * though the fetch that consumes it ignores both. That is deliberate — it
 * makes a DIRECT NAVIGATION to this URL save the file instead of rendering
 * it, so a scripted SVG can never execute in kismet.art's origin (our CSP
 * is Report-Only and would not stop it). The client renders the bytes only
 * via <img src={blobUrl}>, where browsers disable scripting entirely.
 */

const MAX_CONCURRENT_VIEWS = 2
let activeViews = 0

/** Long enough that revisiting an artwork in a session is free, short
 *  enough that a revoked collector's cached copy expires the same day. */
const VIEW_CACHE_SECS = 3600

export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`cfile-view:${ip}`, 60, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const params = parseCfileParams(req)
  if (!params) return errorResponse(400, 'Invalid collection or tokenId')

  try {
    // ---- Gate (outside the reassembly slot, as on the download route).
    const session = await getSessionAddress(req)
    if (!session) return errorResponse(401, 'Sign in to view')
    const gate = await authorizeBySession(params.collection, params.tokenId, session)
    if (!gate.ok) return errorResponse(gate.status, gate.error)
    if (!(await consumeUserQuota('cfile-view', gate.address, 1))) {
      return errorResponse(429, 'Daily view limit reached — try again tomorrow')
    }

    if (await isCfileBlocked(params.collection, params.tokenId)) {
      return errorResponse(423, 'This file is currently unavailable')
    }
    const record = await getCfileRecordStrict(params.collection, params.tokenId)
    const current = record?.current
    if (!current) return errorResponse(404, 'No file attached to this artwork')
    if (!isViewableCfileKind(current.kind)) {
      return errorResponse(415, 'This file type cannot be viewed in the browser — download it instead')
    }

    if (activeViews >= MAX_CONCURRENT_VIEWS) {
      return errorResponse(503, 'Busy — try again in a moment')
    }
    activeViews++
    let bytes: Buffer
    try {
      bytes = await readCfileBlob(params.collection, params.tokenId, current)
    } finally {
      activeViews--
    }
    if (sha256Hex(bytes) !== current.sha256) {
      return errorResponse(500, 'File integrity check failed')
    }

    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        // The real MIME so the fetched blob renders in <img>/<model-viewer>…
        'Content-Type': CFILE_KINDS[current.kind ?? 'zip'].mime,
        'Content-Length': String(bytes.length),
        // …and attachment anyway, so a direct navigation saves rather than
        // renders (the SVG-in-our-origin guard described above).
        'Content-Disposition': `attachment; filename="${current.name}"`,
        'Cache-Control': `private, max-age=${VIEW_CACHE_SECS}`,
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (err) {
    if (err instanceof CfileDataError) {
      return upstreamError(500, 'File could not be retrieved', err, 'cfile-view')
    }
    return upstreamError(503, 'Temporarily unavailable — try again shortly', err, 'cfile-view')
  }
}
