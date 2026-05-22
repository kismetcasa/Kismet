import { NextRequest, NextResponse } from 'next/server'
import { redis } from '@/lib/redis'
import { verifyPrivilegedSession } from '@/lib/curator'
import { errorResponse } from '@/lib/apiResponse'

// Admin/curator-gated read endpoint for the telemetry histograms
// written by /api/telemetry. Returns aggregated counts per
// (platform, surface, effectiveType, bucket) tuple over a configurable
// time window — never per-event detail, since the storage layer is
// already aggregated.
//
// Query params:
//   event    — one of: video_ttff | image_lcp | gateway_winner |
//              optimizer_400 | pool_eviction
//   hours    — lookback window in hours (default 24, max 336 = 14d)

const BUCKET_MS = 5 * 60 * 1000
const VALID_EVENTS = new Set([
  'video_ttff', 'image_lcp', 'gateway_winner', 'optimizer_400', 'pool_eviction',
])
const DEFAULT_HOURS = 24
const MAX_HOURS = 14 * 24

export async function GET(req: NextRequest) {
  const auth = await verifyPrivilegedSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const { searchParams } = new URL(req.url)
  const event = searchParams.get('event') ?? ''
  if (!VALID_EVENTS.has(event)) {
    return errorResponse(400, `event must be one of: ${[...VALID_EVENTS].join(', ')}`)
  }
  const hoursRaw = Number(searchParams.get('hours') ?? DEFAULT_HOURS)
  const hours = Number.isFinite(hoursRaw)
    ? Math.max(1, Math.min(MAX_HOURS, Math.floor(hoursRaw)))
    : DEFAULT_HOURS

  // Enumerate the buckets covering the requested window. The bucket key
  // includes the timestamp so we can read each one with a single HGETALL
  // — no Redis SCAN, no key-pattern matching at query time.
  const now = Date.now()
  const oldestBucket = Math.floor((now - hours * 3600 * 1000) / BUCKET_MS) * BUCKET_MS
  const newestBucket = Math.floor(now / BUCKET_MS) * BUCKET_MS
  const bucketCount = Math.floor((newestBucket - oldestBucket) / BUCKET_MS) + 1

  const reads: Promise<Record<string, string> | null>[] = []
  for (let i = 0; i < bucketCount; i++) {
    const ts = oldestBucket + i * BUCKET_MS
    reads.push(
      redis.hgetall<Record<string, string>>(`kismetart:telemetry:${event}:${ts}`)
        .catch(() => null),
    )
  }
  const buckets = await Promise.all(reads)

  // Aggregate across buckets. Each field is "<platform>:<surface>:<et>:<hist>".
  // Output groups by (platform, surface, effectiveType) → histogram → count.
  const agg = new Map<string, Map<string, number>>()
  for (const bucket of buckets) {
    if (!bucket) continue
    for (const [field, count] of Object.entries(bucket)) {
      const n = Number(count)
      if (!Number.isFinite(n)) continue
      const idx = field.lastIndexOf(':')
      if (idx <= 0) continue
      const groupKey = field.slice(0, idx)
      const histKey = field.slice(idx + 1)
      let group = agg.get(groupKey)
      if (!group) { group = new Map(); agg.set(groupKey, group) }
      group.set(histKey, (group.get(histKey) ?? 0) + n)
    }
  }

  // Materialize for JSON. Sort histogram buckets in their natural
  // (string-comparable) order so the client doesn't have to.
  const result: { group: { platform: string; surface: string; effectiveType: string }; histogram: { bucket: string; count: number }[]; total: number }[] = []
  for (const [groupKey, hist] of agg) {
    const [platform, surface, effectiveType] = groupKey.split(':')
    const histogram = [...hist.entries()]
      .map(([bucket, count]) => ({ bucket, count }))
      .sort((a, b) => a.bucket.localeCompare(b.bucket))
    const total = histogram.reduce((sum, h) => sum + h.count, 0)
    result.push({
      group: { platform, surface, effectiveType },
      histogram,
      total,
    })
  }

  // Sort by total descending so the highest-volume groups appear first
  // in the response — matches how an operator triages: high-volume
  // surfaces first, drill into outliers from there.
  result.sort((a, b) => b.total - a.total)

  return NextResponse.json({
    event,
    windowHours: hours,
    bucketCount,
    groups: result,
  }, {
    // Telemetry data is admin-only and changes constantly — no caching.
    headers: { 'Cache-Control': 'private, no-store' },
  })
}
