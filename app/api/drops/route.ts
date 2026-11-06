import { NextRequest, NextResponse } from 'next/server'
import { getAddress, isAddress } from 'viem'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse, upstreamError } from '@/lib/apiResponse'
import { consumeUserQuota } from '@/lib/userQuota'
import { isBlacklisted } from '@/lib/blacklist'
import { holdsValidPass, isPlatformPausedFor } from '@/lib/gate'
import { verifyTypedIntent } from '@/lib/intentAuth'
import type { IntentEnvelope } from '@/lib/intent'
import { buildOpenDropMessage, OPEN_DROP_TYPES, validateOpenDrop } from '@/lib/drops'
import { isArkivWritable } from '@/lib/arkiv/client'
import { listOpenDrops, listSettlingDrops, writeDrop } from '@/lib/arkiv/drops'
import { getMediaUploader, isDropsEnabled } from '@/lib/dropsStore'

export const runtime = 'nodejs'

/**
 * GET  /api/drops[?artist=0x…] — open drops (soonest-closing first) and drops
 *      waiting to settle, read straight from Arkiv.
 * POST /api/drops — open a drop: verify the artist's OpenDrop intent, check
 *      the Pass gate, and write a read-only `kismet.drop.v1` entity that the
 *      artist owns.
 */
export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`drops-list:${ip}`, 120, 60))) return errorResponse(429, 'Too many requests')
  if (!(await isDropsEnabled())) return errorResponse(404, 'Not found')

  const artistParam = req.nextUrl.searchParams.get('artist')
  if (artistParam && !isAddress(artistParam)) return errorResponse(400, 'Invalid artist address')
  const artist = artistParam ? getAddress(artistParam) : undefined

  const nowSec = Math.floor(Date.now() / 1000)
  try {
    const [open, settling] = await Promise.all([
      listOpenDrops({ nowSec, artist }),
      listSettlingDrops({ nowSec, artist }),
    ])
    return NextResponse.json({ open, settling }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return upstreamError(503, 'Arkiv is unavailable — try again shortly', err, 'drops-list')
  }
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`drops-open:${ip}`, 10, 60))) return errorResponse(429, 'Too many requests')
  if (!(await isDropsEnabled())) return errorResponse(404, 'Not found')
  if (!isArkivWritable()) return errorResponse(503, 'Drops are read-only right now')

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return errorResponse(400, 'Invalid request body')
  }
  if (typeof body.account !== 'string' || !isAddress(body.account)) {
    return errorResponse(400, 'account is required and must be a valid address')
  }
  const account = body.account.toLowerCase()

  const nowSec = Math.floor(Date.now() / 1000)
  const validated = validateOpenDrop(body, nowSec)
  if (!validated.ok) return errorResponse(400, validated.error)
  const fields = validated.value

  // The signature binds every term (title, description hash, artwork, close
  // time, cap) — anything changed between the wallet and here fails it.
  const envelope = body.intent as IntentEnvelope | undefined
  const verified = await verifyTypedIntent({
    envelope,
    account,
    types: OPEN_DROP_TYPES,
    primaryType: 'OpenDrop',
    buildMessage: (nonce, expiresAt) =>
      buildOpenDropMessage(account, fields, nonce, expiresAt) as unknown as Record<string, unknown>,
  })
  if (!verified.ok) return errorResponse(verified.status, verified.error)

  const [blocked, paused, hasPass, uploader] = await Promise.all([
    isBlacklisted(account),
    isPlatformPausedFor(account),
    holdsValidPass(account),
    getMediaUploader(fields.swarmRef),
  ])
  if (blocked) return errorResponse(403, 'Address is blocked')
  if (paused) return errorResponse(503, 'Platform is temporarily paused')
  if (!hasPass) return errorResponse(403, 'A Kismet Pass is required to open a drop')
  // Only artwork uploaded through Kismet's checks (type, size, Pass) in the
  // last two days can back a drop — not an arbitrary Swarm reference.
  if (!uploader) return errorResponse(400, 'Upload the artwork again — that upload has expired')

  if (!(await consumeUserQuota('drop-open', account, 1))) {
    return errorResponse(429, 'Daily drop limit reached — try again tomorrow')
  }

  try {
    const { entityKey, txHash } = await writeDrop({
      artist: getAddress(account),
      fields,
      intent: {
        signature: envelope!.signature as `0x${string}`,
        nonce: envelope!.nonce,
        expiresAt: envelope!.expiresAt,
      },
    })
    return NextResponse.json({ key: entityKey.toLowerCase(), txHash })
  } catch (err) {
    return upstreamError(503, 'Could not record the drop on Arkiv — try again', err, 'drops-open')
  }
}
