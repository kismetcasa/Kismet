import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionAddress } from '@/lib/session'
import { errorResponse, upstreamError } from '@/lib/apiResponse'
import { consumeUserQuota } from '@/lib/userQuota'
import { isBlacklisted } from '@/lib/blacklist'
import { holdsValidPass, isPlatformPausedFor } from '@/lib/gate'
import { DROP_MEDIA_MAX_BYTES, extensionForMediaType, isDropMediaType, sniffImageType } from '@/lib/drops'
import { isDropsEnabled, markUploaded } from '@/lib/dropsStore'
import { isSwarmUploadConfigured, uploadToSwarm } from '@/lib/swarm'

export const runtime = 'nodejs'

/**
 * Upload a claim drop's artwork to Swarm.
 *
 * The browser sends the raw image (Content-Type = its type); Kismet stamps it
 * with the platform's postage batch through its own Bee node, so the node's
 * API and batch are never exposed. Same gate as opening a drop — signed in,
 * a Pass holder, not blocked, platform not paused — because every byte here
 * spends the shared batch. Returns the Swarm reference the OpenDrop intent
 * then signs over.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`drops-media:${ip}`, 10, 60))) return errorResponse(429, 'Too many requests')

  if (!isDropsEnabled()) return errorResponse(404, 'Not found')
  if (!isSwarmUploadConfigured()) return errorResponse(503, 'Drops are not accepting uploads right now')

  const address = await getSessionAddress(req)
  if (!address) return errorResponse(401, 'Sign in to continue')

  const mime = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!isDropMediaType(mime)) return errorResponse(415, 'Upload a PNG, JPEG, GIF or WebP image')
  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > DROP_MEDIA_MAX_BYTES) return errorResponse(413, 'Images are capped at 15 MB')

  const [blocked, paused, hasPass] = await Promise.all([
    isBlacklisted(address),
    isPlatformPausedFor(address),
    holdsValidPass(address),
  ])
  if (blocked) return errorResponse(403, 'Address is blocked')
  if (paused) return errorResponse(503, 'Platform is temporarily paused')
  if (!hasPass) return errorResponse(403, 'A Kismet Pass is required to open a drop')

  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await req.arrayBuffer())
  } catch {
    return errorResponse(400, 'Could not read the upload')
  }
  if (bytes.byteLength === 0) return errorResponse(400, 'Empty upload')
  if (bytes.byteLength > DROP_MEDIA_MAX_BYTES) return errorResponse(413, 'Images are capped at 15 MB')
  if (sniffImageType(bytes) !== mime) return errorResponse(415, 'The file is not the image type it claims to be')

  // Count, then bytes — debited only once the upload is known to be valid.
  if (!(await consumeUserQuota('drop-media', address, 1))) {
    return errorResponse(429, 'Daily drop upload limit reached — try again tomorrow')
  }
  if (!(await consumeUserQuota('drop-bytes', address, bytes.byteLength))) {
    return errorResponse(429, 'Daily drop upload size limit reached — try again tomorrow')
  }

  let reference: string
  try {
    ;({ reference } = await uploadToSwarm(bytes, mime, `drop.${extensionForMediaType(mime)}`))
  } catch (err) {
    return upstreamError(502, 'Upload to Swarm failed — try again', err, 'drops-media')
  }

  try {
    await markUploaded(reference)
  } catch (err) {
    return upstreamError(503, 'Temporarily unavailable — please retry', err, 'drops-media')
  }

  return NextResponse.json({ reference, mime, size: bytes.byteLength })
}
