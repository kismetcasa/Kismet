import { NextRequest } from 'next/server'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse, upstreamError } from '@/lib/apiResponse'
import { DROP_MEDIA_MAX_BYTES, isEntityKey, normalizeEntityKey } from '@/lib/drops'
import { getDropRecord, isDropsEnabled } from '@/lib/dropsStore'
import { fetchFromSwarm } from '@/lib/swarm'

export const runtime = 'nodejs'

/**
 * GET /api/drops/{key}/media — a drop's artwork, streamed from Swarm.
 *
 * Keyed by the DROP, not the Swarm reference: only artwork that backs a
 * Kismet-written drop is ever served, never an arbitrary file someone put on
 * Swarm. The Content-Type comes from the drop entity (an image type validated
 * at upload), with nosniff; the body is cut off at the upload cap. The drop
 * is readonly, so the response is immutable and caches for good.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`drops-art:${ip}`, 240, 60))) return errorResponse(429, 'Too many requests')
  if (!isDropsEnabled()) return errorResponse(404, 'Not found')

  const { key: raw } = await params
  if (!isEntityKey(raw)) return errorResponse(400, 'Invalid drop key')

  let drop
  try {
    drop = await getDropRecord(normalizeEntityKey(raw))
  } catch (err) {
    return upstreamError(503, 'Arkiv is unavailable — try again shortly', err, 'drops-art')
  }
  if (!drop) return errorResponse(404, 'Drop not found — it may have expired')

  const upstream = await fetchFromSwarm(drop.swarmRef)
  if (!upstream?.body) return errorResponse(502, 'Swarm did not return the artwork — try again')

  const declared = Number(upstream.headers.get('content-length') ?? 0)
  if (declared > DROP_MEDIA_MAX_BYTES) {
    await upstream.body.cancel().catch(() => {})
    return errorResponse(502, 'Artwork is larger than a drop allows')
  }

  // Cut the stream off at the cap even when the source sent no length.
  let seen = 0
  const limited = upstream.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength
        if (seen > DROP_MEDIA_MAX_BYTES) {
          controller.error(new Error('artwork exceeds the drop size cap'))
          return
        }
        controller.enqueue(chunk)
      },
    }),
  )

  const headers = new Headers({
    'Content-Type': drop.mime,
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
    'Cache-Control': 'public, max-age=31536000, immutable',
  })
  if (declared > 0) headers.set('Content-Length', String(declared))
  return new Response(limited, { headers })
}
