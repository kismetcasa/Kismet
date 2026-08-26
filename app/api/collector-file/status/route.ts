import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionAddress } from '@/lib/session'
import {
  getCfileRecord,
  getDownloadedVersion,
  toPublicDescriptor,
} from '@/lib/collectorFile'
import { parseCfileParams } from '@/lib/collectorFileGate'

export const runtime = 'nodejs'

/**
 * Public-descriptor + viewer-state read for the artwork-page card: the file's
 * display facts (never uri/iv/keyId) plus, for a signed-in viewer, the last
 * version they downloaded — which powers the "update available" badge
 * (COLLECTOR_DOWNLOADS_DESIGN.md §6.4, the passive floor that reaches
 * everyone push and the bell miss). Ownership is NOT decided here — the
 * client's own balanceOf drives the card's holder affordances, and the
 * ticket route re-runs the authoritative gate on click.
 */
export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`cfile-status:${ip}`, 60, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const params = parseCfileParams(req)
  if (!params) return errorResponse(400, 'Invalid collection or tokenId')

  const record = await getCfileRecord(params.collection, params.tokenId)
  const file = toPublicDescriptor(record)
  if (!file) {
    return NextResponse.json({ file: null }, { headers: { 'Cache-Control': 'private, no-store' } })
  }

  const viewer = await getSessionAddress(req).catch(() => null)
  const downloadedV = viewer
    ? await getDownloadedVersion(params.collection, params.tokenId, viewer)
    : null

  return NextResponse.json(
    { file, downloadedV },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
