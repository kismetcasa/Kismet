import { NextRequest, NextResponse } from 'next/server'
import { redis } from '@/lib/redis'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { verifyAdminSession } from '@/lib/curator'
import { errorResponse } from '@/lib/apiResponse'
import { isAddress } from '@/lib/address'

export const dynamic = 'force-dynamic'

// TEMPORARY diagnostics route for the Redis topology decision documented in
// REDIS_IMPLEMENTATION_REVIEW.md (Part VI "measure first"). Reports, in one
// read-only response, everything that otherwise requires SSH + docker exec:
//
//   - RTT from THIS process to Upstash (10 sequential timed PINGs — the
//     app's-eye view of the per-command cross-cloud round trip; sample 0
//     includes the cold connection/TLS setup, samples 1-9 are steady-state)
//   - the OCI region this container runs in (instance metadata, best-effort)
//   - dataset cardinalities for the key families with growth concerns
//   - process memory (headroom check for a co-located Redis)
//
// Access: admin session cookie (visit in the browser while signed in as
// admin) OR `Authorization: Bearer <CRON_SECRET>` / `?secret=` — the same
// dual pattern as /api/cron/sync-stats. Emits timings/counts only, never
// env values. Total Redis cost per call: ~25 commands.
//
// REMOVE once the measurement phase is done — this is scaffolding, not product.

const CARDINALITY_KEYS: { key: string; kind: 'scard' | 'zcard' }[] = [
  { key: 'kismetart:collections', kind: 'scard' },
  { key: 'kismetart:created-collections', kind: 'scard' },
  { key: 'kismetart:created-mints', kind: 'scard' },
  { key: 'kismetart:profiles', kind: 'scard' },
  { key: 'kismetart:hidden-users', kind: 'scard' },
  { key: 'kismetart:hidden-profiles', kind: 'scard' },
  { key: 'kismetart:hidden-moments', kind: 'scard' },
  { key: 'kismetart:hidden-collections', kind: 'scard' },
  { key: 'kismetart:listings', kind: 'zcard' },
  { key: 'kismetart:trending', kind: 'zcard' },
  { key: 'kismetart:trending-latest', kind: 'zcard' },
  { key: 'kismetart:sale-ends', kind: 'zcard' },
  { key: 'kismetart:sale-free', kind: 'zcard' },
  { key: 'kismetart:featured', kind: 'zcard' },
]

const PING_SAMPLES = 10

async function fetchOciRegion(): Promise<string | null> {
  // OCI instance metadata v2. Reachable from bridge-networked containers on
  // most OCI hosts; a 1.5s timeout keeps an unreachable metadata service from
  // stalling the response. Best-effort — null just means "read the region
  // from the Oracle Cloud console instead".
  try {
    const res = await fetch(
      'http://169.254.169.254/opc/v2/instance/canonicalRegionName',
      {
        headers: { Authorization: 'Bearer Oracle' },
        signal: AbortSignal.timeout(1500),
        cache: 'no-store',
      },
    )
    if (!res.ok) return null
    const text = (await res.text()).trim()
    return text || null
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`debug-redis-rtt:${ip}`, 10, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  // Auth: CRON_SECRET first (no Redis read), then the admin session cookie.
  const secret = process.env.CRON_SECRET?.trim()
  const auth = req.headers.get('authorization')
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null
  const provided = (bearer ?? new URL(req.url).searchParams.get('secret') ?? '').trim()
  let authorized = Boolean(secret && provided && provided === secret)
  if (!authorized) {
    const session = await verifyAdminSession()
    if ('error' in session) return errorResponse(session.status, session.error)
    authorized = true
  }

  // --- RTT: sequential awaited PINGs so auto-pipelining can't batch them ---
  const samples: number[] = []
  let pingError: string | null = null
  for (let i = 0; i < PING_SAMPLES; i++) {
    const started = performance.now()
    try {
      await redis.ping()
      samples.push(Number((performance.now() - started).toFixed(1)))
    } catch (err) {
      pingError = err instanceof Error ? err.message : String(err)
      break
    }
  }
  const steady = samples.slice(1).sort((a, b) => a - b)
  const median = steady.length
    ? steady[Math.floor(steady.length / 2)]
    : null

  // --- Dataset cardinalities: one auto-pipelined batch, per-key best-effort ---
  const [dbsize, ...counts] = await Promise.all([
    redis.dbsize().catch(() => null),
    ...CARDINALITY_KEYS.map(({ key, kind }) =>
      (kind === 'scard' ? redis.scard(key) : redis.zcard(key)).catch(() => null),
    ),
  ])
  const cardinalities: Record<string, number | null> = {}
  CARDINALITY_KEYS.forEach(({ key }, i) => {
    cardinalities[key] = counts[i]
  })

  // Optional: ?followers=0x... sizes one creator's follower set (fan-out reality)
  const followersParam = new URL(req.url).searchParams.get('followers')
  let followers: { address: string; count: number | null } | null = null
  if (followersParam && isAddress(followersParam)) {
    const addr = followersParam.toLowerCase()
    followers = {
      address: addr,
      count: await redis.scard(`kismetart:followers:${addr}`).catch(() => null),
    }
  }

  const region = await fetchOciRegion()
  const mem = process.memoryUsage()
  const toMb = (n: number) => Math.round(n / 1024 / 1024)

  return NextResponse.json({
    ok: !pingError,
    at: new Date().toISOString(),
    node: process.version,
    env: {
      restUrlSet: Boolean(process.env.UPSTASH_REDIS_REST_URL),
      restTokenSet: Boolean(process.env.UPSTASH_REDIS_REST_TOKEN),
    },
    ociRegion: region,
    rtt: {
      error: pingError,
      samples_ms: samples,
      cold_ms: samples[0] ?? null,
      steady_min_ms: steady[0] ?? null,
      steady_median_ms: median,
      steady_max_ms: steady[steady.length - 1] ?? null,
    },
    memory_mb: {
      rss: toMb(mem.rss),
      heapUsed: toMb(mem.heapUsed),
      heapTotal: toMb(mem.heapTotal),
      external: toMb(mem.external),
    },
    dataset: { dbsize, cardinalities, followers },
  })
}
