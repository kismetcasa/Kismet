import { NextRequest, NextResponse } from 'next/server'
import { errorResponse, upstreamError } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionAddress } from '@/lib/session'
import { consumeUserQuota } from '@/lib/userQuota'
import { openCfile, cfileRef, sha256Hex } from '@/lib/collectorFileCore'
import { formatCfileSize } from '@/lib/collectorFileTypes'
import {
  CfileFetchError,
  consumeCfileTicket,
  fetchSealedCfile,
  getCfileMasterKey,
  getCfileRecordStrict,
  isCfileBlocked,
  markCfileVersionServed,
  peekCfileTicket,
  recordCfileDownload,
  type CfileTicket,
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
 * Single-use is enforced at the LAST safe moment, not the first: the ticket
 * is peeked (validated without deletion) up front and consumed only after
 * the sealed bytes are fetched and decrypted — so a busy 503, a transient
 * gateway failure, or a link-preview bot's probe never burns it and the
 * same URL simply works on retry. Copy-link (share) tickets additionally
 * answer their bare GET with a tiny confirmation page: messenger unfurlers
 * and URL-bar prefetchers GET links without clicking, and a direct-download
 * answer would let them redeem (and receive) the file before the human can.
 * Explicit prefetch requests (Sec-Purpose/Purpose headers) get 204 for the
 * same reason.
 *
 * Buffer-then-send, not streaming: GCM must not release unauthenticated
 * plaintext, so ciphertext and plaintext are briefly co-resident (~2× file
 * size, capped 16 MiB). MAX_CONCURRENT 2 bounds concurrent DECRYPT work
 * (≤64 MB of working buffers) and brackets ONLY the fetch/decrypt section —
 * auth/gate reads run outside the slot so a slow RPC can't starve it.
 * Response bodies additionally live until each client drains them, which
 * the per-IP rate limit and per-identity quota bound. All against the 6 GB
 * container limit — Buffers are off-heap. Authorization reads are
 * strictRead/fail-closed; a Redis or RPC outage answers 503, never bytes.
 */

const MAX_CONCURRENT_DOWNLOADS = 2
let activeDownloads = 0

function isPrefetch(req: NextRequest): boolean {
  const purpose = (req.headers.get('sec-purpose') ?? req.headers.get('purpose') ?? '').toLowerCase()
  return purpose.includes('prefetch') || purpose.includes('preview')
}

/** Minimal confirmation page for share-ticket GETs — the human clicks
 *  through (adding go=1, which is what actually redeems); bots that only
 *  unfurl never do. Static markup, artist input confined to the
 *  server-normalized ASCII filename and numeric size. */
function confirmPage(req: NextRequest, name: string, size: number): NextResponse {
  const go = new URL(req.url)
  go.searchParams.set('go', '1')
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Kismet download</title></head><body style="margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#0a0a0a;color:#eaeaea;font-family:ui-monospace,monospace"><div style="text-align:center;padding:24px"><p style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#888">collector download</p><p style="font-size:14px;margin:12px 0">${name} · ${formatCfileSize(size)}</p><a href="${go.pathname}?${go.searchParams.toString()}" style="display:inline-block;margin-top:8px;padding:10px 18px;border:1px solid #333;color:#eaeaea;text-decoration:none;font-size:12px;letter-spacing:.1em;text-transform:uppercase">download</a><p style="font-size:10px;color:#666;margin-top:14px">single-use link — downloads once, on this click</p></div></body></html>`
  return new NextResponse(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' },
  })
}

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

  // Speculative loads must never redeem a capability URL. 204 keeps
  // prefetchers quiet without consuming anything; the real navigation
  // follows without these headers.
  if (isPrefetch(req)) return new NextResponse(null, { status: 204 })

  const ticketToken = req.nextUrl.searchParams.get('ticket')
  try {
    // ---- Resolve WHO is downloading — everything here runs OUTSIDE the
    // decrypt slot (a slow FC/RPC gate must not starve other downloads),
    // and nothing here consumes the ticket yet.
    let ticket: CfileTicket | null = null
    let downloader: string
    if (ticketToken) {
      ticket = await peekCfileTicket(ticketToken)
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

    // Copy-link tickets: a bare GET gets the click-through page (bots
    // unfurl, humans click). The go=1 the button carries is what redeems.
    if (ticket?.share && req.nextUrl.searchParams.get('go') !== '1') {
      return confirmPage(req, current.name, current.size)
    }

    // ---- The decrypt slot: fetch + decrypt only.
    if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
      // Nothing consumed above, so this 503 costs the user a retry, not a
      // ticket or a quota unit.
      return errorResponse(503, 'Busy — try again in a moment')
    }
    activeDownloads++
    let plaintext: Buffer
    try {
      const sealed = await fetchSealedCfile(current.uri)
      try {
        plaintext = openCfile(masterKey, current.keyId, sealed)
      } catch (err) {
        // Tag failure = the stored pointer and the bytes disagree — a data
        // problem, never something to serve.
        return upstreamError(500, 'File integrity check failed', err, 'cfile-dl')
      }
    } finally {
      activeDownloads--
    }
    if (sha256Hex(plaintext) !== current.sha256) {
      return errorResponse(500, 'File integrity check failed')
    }

    // ---- Success is certain; NOW consume the single-use ticket. A racer
    // who redeemed the same token between peek and here wins it — the
    // loser 403s without bytes, preserving single-use exactly.
    if (ticketToken) {
      const consumed = await consumeCfileTicket(ticketToken)
      if (!consumed) {
        return errorResponse(403, 'This download link has expired — request a new one')
      }
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
  } catch (err) {
    if (err instanceof CfileFetchError) {
      // Transient upstream: the ticket was NOT consumed, so the same URL
      // retries cleanly once the gateway recovers (the failed-fetch memo
      // just keeps repeats cheap in the meantime).
      return err.transient
        ? errorResponse(503, 'File storage is temporarily unreachable — try again shortly')
        : upstreamError(500, 'File could not be retrieved', err, 'cfile-dl')
    }
    // strictRead throw (Redis outage on a gated read) and anything else.
    return upstreamError(503, 'Temporarily unavailable — try again shortly', err, 'cfile-dl')
  }
}
