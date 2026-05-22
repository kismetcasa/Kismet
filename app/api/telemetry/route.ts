import { NextRequest } from 'next/server'
import { redis } from '@/lib/redis'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'

// Edge runtime — telemetry should be cheap globally; no Redis-specific
// reason to stay on Node. Upstash works over fetch from edge.
export const runtime = 'edge'

// Bucket events into 5-minute windows. Tight enough for hour-resolution
// dashboards, loose enough that even a busy moment in production only
// writes ~1 HINCRBY per (event, platform, bucket) tuple per 5 min.
const BUCKET_MS = 5 * 60 * 1000

// Cap a single payload's events. Clients buffer between flushes, but a
// single 60s window shouldn't exceed this even on a heavy scroll feed.
const MAX_EVENTS_PER_REQUEST = 50

// TTL the Redis keys so old buckets self-evict — 14 days is enough to
// chart week-over-week drift without paying for unbounded storage.
const BUCKET_TTL_SECONDS = 14 * 24 * 60 * 60

const VALID_NAMES = new Set([
  'video_ttff',
  'image_lcp',
  'gateway_winner',
  'optimizer_400',
  'pool_eviction',
])

const VALID_SURFACES = new Set([
  'feed', 'moment', 'collection', 'profile', 'market', 'mint', 'admin', 'other',
])

const VALID_PLATFORMS = new Set([
  'miniapp-ios', 'miniapp-android', 'miniapp-other',
  'mobile-ios', 'mobile-android', 'desktop',
])

/**
 * Place a value into a fixed histogram bucket so the server stores a
 * bounded keyspace per event×dimension combo. Buckets chosen to give
 * useful p50/p95 resolution across the expected ms range while
 * collapsing the long tail into a single overflow bucket.
 *
 * For counters (gateway_winner, optimizer_400, pool_eviction) the
 * value is the categorical/integer value itself — no bucketing needed.
 */
function histogramBucket(name: string, value: number): string {
  if (name === 'gateway_winner' || name === 'optimizer_400' || name === 'pool_eviction') {
    return String(Math.max(0, Math.floor(value)))
  }
  // Timing events (ms): geometric buckets from 50ms up to 10s
  // 50, 100, 200, 400, 800, 1600, 3200, 6400, 10000+
  const v = Math.max(0, value)
  if (v < 50) return '0-50'
  if (v < 100) return '50-100'
  if (v < 200) return '100-200'
  if (v < 400) return '200-400'
  if (v < 800) return '400-800'
  if (v < 1600) return '800-1600'
  if (v < 3200) return '1600-3200'
  if (v < 6400) return '3200-6400'
  if (v < 10000) return '6400-10000'
  return '10000+'
}

interface IncomingEvent {
  name?: unknown
  value?: unknown
  dims?: { surface?: unknown; platform?: unknown; effectiveType?: unknown }
}

interface ValidEvent {
  name: string
  value: number
  surface: string
  platform: string
  effectiveType?: string
}

function validate(e: IncomingEvent): ValidEvent | null {
  if (typeof e.name !== 'string' || !VALID_NAMES.has(e.name)) return null
  if (typeof e.value !== 'number' || !Number.isFinite(e.value)) return null
  if (e.value < 0 || e.value > 600_000) return null  // cap at 10min
  const surface = typeof e.dims?.surface === 'string' && VALID_SURFACES.has(e.dims.surface)
    ? e.dims.surface
    : 'other'
  const platform = typeof e.dims?.platform === 'string' && VALID_PLATFORMS.has(e.dims.platform)
    ? e.dims.platform
    : 'desktop'
  // effectiveType is an enum from the Network Information API; allowlist.
  const et = e.dims?.effectiveType
  const effectiveType =
    typeof et === 'string' && ['slow-2g', '2g', '3g', '4g'].includes(et)
      ? et
      : undefined
  return { name: e.name, value: e.value, surface, platform, effectiveType }
}

export async function POST(req: NextRequest) {
  // Coarse per-IP ratelimit — telemetry is fire-and-forget, but a buggy
  // client looping trackPerf would otherwise saturate Redis writes. The
  // IP is used ONLY for ratelimiting, never logged or stored.
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`telemetry:${ip}`, 120, 60)
  if (!allowed) return new Response(null, { status: 429 })

  let body: { events?: unknown }
  try {
    body = await req.json()
  } catch {
    return new Response(null, { status: 400 })
  }
  const events = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS_PER_REQUEST) : []
  if (events.length === 0) return new Response(null, { status: 204 })

  const bucket = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS
  // Group hash writes by (name) so each Redis HINCRBY targets a single key.
  // Field is "<platform>:<surface>:<effectiveType-or-na>:<histogram-bucket>".
  const pipeline: Promise<unknown>[] = []
  for (const raw of events) {
    const e = validate(raw as IncomingEvent)
    if (!e) continue
    const key = `kismetart:telemetry:${e.name}:${bucket}`
    const field = `${e.platform}:${e.surface}:${e.effectiveType ?? 'na'}:${histogramBucket(e.name, e.value)}`
    pipeline.push(
      redis.hincrby(key, field, 1).then(() =>
        // Refresh TTL on each write — buckets that see traffic stay
        // alive for the full retention window; dead buckets self-evict.
        redis.expire(key, BUCKET_TTL_SECONDS),
      ).catch(() => { /* swallow; one lost event doesn't matter */ }),
    )
  }
  await Promise.all(pipeline)

  // 204 No Content — telemetry callers don't need a body, and skipping
  // it shaves bytes off every response.
  return new Response(null, { status: 204 })
}
