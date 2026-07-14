import { NextResponse, type NextRequest } from 'next/server'
import { redis } from '@/lib/redis'
import { FUNNEL_EVENTS } from '@/lib/funnel'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'

/**
 * Sink for the first-party funnel counters (lib/funnel.ts). Mirrors the
 * /api/client-error posture: never trusts the body, allowlists the event
 * names, rate-limits per IP, and always returns 204 so instrumentation can't
 * become an error path (or a log/keyspace flood).
 *
 * Storage: INCR kismetart:funnel:<event>:<YYYY-MM-DD>, 90-day TTL. Counts
 * only — no identifiers, nothing per-user.
 */
export const dynamic = 'force-dynamic'

const EVENTS = new Set<string>(FUNNEL_EVENTS)

const TTL_SECONDS = 90 * 24 * 60 * 60

export async function POST(req: NextRequest) {
  if (!(await checkRateLimit(`funnel:${getClientIp(req)}`, 60, 60))) {
    return new NextResponse(null, { status: 204 })
  }
  try {
    const text = await req.text()
    if (text.length > 256) return new NextResponse(null, { status: 204 })
    let event: unknown
    try {
      event = (JSON.parse(text) as { event?: unknown }).event
    } catch {
      return new NextResponse(null, { status: 204 })
    }
    if (typeof event !== 'string' || !EVENTS.has(event)) {
      return new NextResponse(null, { status: 204 })
    }
    const day = new Date().toISOString().slice(0, 10)
    const key = `kismetart:funnel:${event}:${day}`
    // INCR + refresh TTL each write — a rolling 90-day window per day-bucket.
    await redis
      .multi()
      .incr(key)
      .expire(key, TTL_SECONDS)
      .exec()
  } catch {
    // Counting must never fail loudly.
  }
  return new NextResponse(null, { status: 204 })
}
