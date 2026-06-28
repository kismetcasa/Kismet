import { NextResponse } from 'next/server'
import { Redis } from '@upstash/redis'
import { serverBaseClient } from '@/lib/rpc'

/**
 * Readiness probe. 200 when this pod can serve a typical request; 503 only
 * when Redis is unreachable for a SUSTAINED window (see the consecutive-
 * failure tolerance below). Redis is the hard gate — without it the pod can't
 * serve sessions or feeds. Base RPC is checked but NON-gating: it's needed by
 * only a few flows (mint verification, on-chain permission reads), so a
 * provider blip must not fail readiness and pull every pod from the LB,
 * darkening read-only browsing over a dependency most requests never touch
 * (SRE "Addressing Cascading Failures": don't let a non-essential dependency
 * flip the health check and cascade the outage). RPC trouble surfaces as
 * `degraded:true` for observability. Coolify reads the 503 to remove the pod
 * from the LB without restarting it (cf. /api/health for restart). Per-check
 * timeout so a hung TCP connection doesn't hold Coolify's probe open until its
 * own HTTP timeout fires.
 *
 * Two hardenings against false-503 eviction of our SINGLE pod (evicting the
 * only backend just darkens the whole site — there is no peer to fail over
 * to, so a transient blip must not flip readiness):
 *  1. A DEDICATED Upstash client with auto-pipelining OFF. The shared
 *     lib/redis client batches every command issued in the same event-loop
 *     tick into one REST round trip whose latency tracks its LARGEST member;
 *     a concurrent timeline `zrange(0,9999)` or a big `smembers` landing in
 *     the same tick would make a co-batched `ping()` blow the timeout even
 *     when Redis is healthy. An isolated client keeps the ping's latency a
 *     true signal of Redis health.
 *  2. CONSECUTIVE-failure tolerance: only report not-ready after N failures
 *     in a row (mirrors the SRE / Kubernetes guidance to set failureThreshold
 *     3-5 and never hard-gate readiness on a single variable-latency check).
 *     A genuine sustained outage still trips it within N ticks; a one-off REST
 *     latency spike does not.
 */
export const dynamic = 'force-dynamic'

const CHECK_TIMEOUT_MS = 3_000

// Number of consecutive Redis-check failures tolerated before reporting
// not-ready. Pair with Coolify's own probe `failureThreshold` — this is the
// in-app floor so the behavior holds regardless of how the external probe is
// tuned.
const READINESS_FAILURE_THRESHOLD = 3
let consecutiveRedisFailures = 0

// Isolated, non-pipelined client for the probe only (see hardening #1 above).
const probeRedis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL ?? 'https://placeholder.upstash.io',
  token: process.env.UPSTASH_REDIS_REST_TOKEN ?? 'placeholder',
  enableAutoPipelining: false,
})

interface CheckResult {
  ok: boolean
  latencyMs: number
  error?: string
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function check(label: string, fn: () => Promise<unknown>): Promise<CheckResult> {
  const start = performance.now()
  try {
    await withTimeout(fn(), CHECK_TIMEOUT_MS, label)
    return { ok: true, latencyMs: Math.round(performance.now() - start) }
  } catch (err) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function GET() {
  const [redisCheck, rpcCheck] = await Promise.all([
    check('redis', () => probeRedis.ping()),
    check('rpc', () => serverBaseClient().getBlockNumber()),
  ])

  // Track consecutive Redis failures so a single transient blip can't evict
  // our only pod. Reset on any success; only flip to not-ready once Redis has
  // failed READINESS_FAILURE_THRESHOLD times in a row (a sustained outage).
  if (redisCheck.ok) consecutiveRedisFailures = 0
  else consecutiveRedisFailures++
  const redisSustainedDown = consecutiveRedisFailures >= READINESS_FAILURE_THRESHOLD

  // Redis is the hard gate (see the module docstring), but only after the
  // sustained-failure threshold. RPC failure is reported as `degraded` but
  // never fails readiness — gating on it would let a Base RPC blip evict the
  // pod and dark the site. A momentary Redis blip is `degraded` too, until it
  // proves sustained.
  const ready = !redisSustainedDown
  const degraded = !rpcCheck.ok || !redisCheck.ok
  return NextResponse.json(
    {
      ready,
      degraded,
      redis: redisCheck,
      rpc: rpcCheck,
      consecutiveRedisFailures,
      timestamp: Date.now(),
    },
    {
      status: ready ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  )
}
