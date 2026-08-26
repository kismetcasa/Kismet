import { NextRequest, NextResponse } from 'next/server'
import { errorResponse, upstreamError } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionAddress } from '@/lib/session'
import { consumeUserQuota } from '@/lib/userQuota'
import { openCfile, cfileRef, sha256Hex } from '@/lib/collectorFileCore'
import {
  CfileFetchError,
  consumeCfileTicket,
  fetchSealedCfile,
  getCfileMasterKey,
  getCfileRecordStrict,
  isCfileBlocked,
  markCfileVersionServed,
  recordCfileDownload,
} from '@/lib/collectorFile'
import { authorizeBySession, parseCfileParams } from '@/lib/collectorFileGate'

export const runtime = 'nodejs'

/**
 * The gated byte transfer (COLLECTOR_DOWNLOADS_DESIGN.md §5). Two ways in:
 *
 *   ?ticket=<token> — a single-use capability minted by /api/collector-file/
 *   ticket after the full gate ran there. No auth here: the ticket IS the
 *   auth, which is what lets a Mini App hand the URL to the device browser
 *   (sdk.actions.openUrl) where no session exists.
 *
 *   session — a cookie-carrying same-site navigation (web <a href>). Runs
 *   the session gate + quota inline.
 *
 * Buffer-then-send, not streaming: GCM must not release unauthenticated
 * plaintext, so ciphertext and plaintext are briefly co-resident (~2× file
 * size, capped 16 MiB, MAX_CONCURRENT 2 ⇒ ≤64 MB against the 6 GB container
 * limit — Buffers are off-heap). Authorization reads are strictRead/fail-
 * closed; a Redis or RPC outage answers 503, never bytes.
 */

const MAX_CONCURRENT_DOWNLOADS = 2
let activeDownloads = 0

export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`cfile-dl:${ip}`, 20, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const params = parseCfileParams(req)
  if (!params) return errorResponse(400, 'Invalid collection or tokenId')

  let masterKey: string
  try {
    masterKey = getCfileMasterKey()
  } catch {
    return errorResponse(500, 'Collector files are not configured on this deployment')
  }

  // Resolve WHO is downloading — ticket first (the normal client path).
  const ticketToken = req.nextUrl.searchParams.get('ticket')
  let downloader: string
  try {
    if (ticketToken) {
      const ticket = await consumeCfileTicket(ticketToken)
      if (!ticket || ticket.ref !== cfileRef(params.collection, params.tokenId)) {
        return errorResponse(403, 'This download link has expired — request a new one')
      }
      downloader = ticket.addr
    } else {
      const session = await getSessionAddress(req)
      if (!session) return errorResponse(401, 'Sign in to download')
      const gate = await authorizeBySession(params.collection, params.tokenId, session)
      if (!gate.ok) return errorResponse(gate.status, gate.error)
      downloader = gate.address
      if (!(await consumeUserQuota('cfile-download', downloader, 1))) {
        return errorResponse(429, 'Daily download limit reached — try again tomorrow')
      }
    }

    // Gated-state reads are strictRead — a Redis outage 503s below via catch.
    if (await isCfileBlocked(params.collection, params.tokenId)) {
      return errorResponse(423, 'This file is currently unavailable')
    }
    const record = await getCfileRecordStrict(params.collection, params.tokenId)
    const current = record?.current
    if (!current) return errorResponse(404, 'No file attached to this artwork')

    if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
      return errorResponse(503, 'Busy — try again in a moment')
    }
    activeDownloads++
    try {
      const sealed = await fetchSealedCfile(current.uri)
      let plaintext: Buffer
      try {
        plaintext = openCfile(masterKey, current.keyId, sealed)
      } catch (err) {
        // Tag failure = the stored pointer and the bytes disagree — a data
        // problem, never something to serve.
        return upstreamError(500, 'File integrity check failed', err, 'cfile-dl')
      }
      if (sha256Hex(plaintext) !== current.sha256) {
        return errorResponse(500, 'File integrity check failed')
      }

      // First successful serve clears a pending (propagation-unverified) flag.
      if (current.pending) {
        void markCfileVersionServed(params.collection, params.tokenId, current.keyId).catch(() => {})
      }
      void recordCfileDownload(params.collection, params.tokenId, downloader, current.v).catch(() => {})

      return new NextResponse(new Uint8Array(plaintext), {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Length': String(plaintext.length),
          // name is server-normalized ASCII (normalizeCfileName) — quote-safe.
          'Content-Disposition': `attachment; filename="${current.name}"`,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } finally {
      activeDownloads--
    }
  } catch (err) {
    if (err instanceof CfileFetchError) {
      return err.transient
        ? errorResponse(503, 'File storage is temporarily unreachable — try again shortly')
        : upstreamError(500, 'File could not be retrieved', err, 'cfile-dl')
    }
    // strictRead throw (Redis outage on a gated read) and anything else.
    return upstreamError(503, 'Temporarily unavailable — try again shortly', err, 'cfile-dl')
  }
}
