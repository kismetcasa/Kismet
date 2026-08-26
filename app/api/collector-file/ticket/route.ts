import { NextRequest, NextResponse } from 'next/server'
import { errorResponse, upstreamError } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionAddress } from '@/lib/session'
import { consumeUserQuota } from '@/lib/userQuota'
import { SITE_URL } from '@/lib/siteUrl'
import {
  CFILE_SHARE_TICKET_TTL_SECS,
  CFILE_TICKET_TTL_SECS,
  getCfileRecordStrict,
  isCfileBlocked,
  mintCfileTicket,
} from '@/lib/collectorFile'
import {
  authorizeByProof,
  authorizeBySession,
  parseCfileParams,
  type DownloadProofInput,
} from '@/lib/collectorFileGate'

export const runtime = 'nodejs'

/**
 * Mint a single-use download ticket (COLLECTOR_DOWNLOADS_DESIGN.md §5.1
 * path 4). The FULL collector gate runs here — session identity across the
 * bounded FC-sibling union (+ the post-collect grace marker), or the signed
 * wallet proof (ERC-1271-aware) for holders outside the union / sessionless
 * web — and the returned URL then needs no auth at all, so a Mini App can
 * hand it to the device browser via sdk.actions.openUrl (in-app navigations
 * carry no credentials; RN WebViews can't save blobs).
 *
 * ?share=1 mints the longer-TTL copy-link variant ("get this on my desktop").
 * Still single-use.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`cfile-ticket:${ip}`, 20, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const params = parseCfileParams(req)
  if (!params) return errorResponse(400, 'Invalid collection or tokenId')

  const body = (await req.json().catch(() => null)) as { proof?: DownloadProofInput } | null
  const share = req.nextUrl.searchParams.get('share') === '1'

  try {
    // Resolve + authorize the downloader.
    let address: string
    if (body?.proof) {
      const gate = await authorizeByProof(params.collection, params.tokenId, body.proof)
      if (!gate.ok) return errorResponse(gate.status, gate.error)
      address = gate.address
    } else {
      const session = await getSessionAddress(req)
      if (!session) return errorResponse(401, 'Sign in or verify with your wallet')
      const gate = await authorizeBySession(params.collection, params.tokenId, session)
      if (!gate.ok) return errorResponse(gate.status, gate.error)
      address = gate.address
    }

    // The download itself may be sessionless (the ticket is the auth), so the
    // per-identity meter debits HERE, at the gate moment.
    if (!(await consumeUserQuota('cfile-download', address, 1))) {
      return errorResponse(429, 'Daily download limit reached — try again tomorrow')
    }

    if (await isCfileBlocked(params.collection, params.tokenId)) {
      return errorResponse(423, 'This file is currently unavailable')
    }
    const record = await getCfileRecordStrict(params.collection, params.tokenId)
    const current = record?.current
    if (!current) return errorResponse(404, 'No file attached to this artwork')

    const token = await mintCfileTicket(
      params.collection,
      params.tokenId,
      address,
      current.v,
      current.name,
      { share },
    )
    const url = `${SITE_URL}/api/collector-file/download?collection=${params.collection}&tokenId=${params.tokenId}&ticket=${token}`
    return NextResponse.json({
      url,
      name: current.name,
      size: current.size,
      v: current.v,
      expiresInSecs: share ? CFILE_SHARE_TICKET_TTL_SECS : CFILE_TICKET_TTL_SECS,
    })
  } catch (err) {
    return upstreamError(503, 'Temporarily unavailable — try again shortly', err, 'cfile-ticket')
  }
}
