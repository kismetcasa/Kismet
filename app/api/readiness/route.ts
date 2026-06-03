import { NextResponse } from 'next/server'
import { redis } from '@/lib/redis'
import { serverBaseClient } from '@/lib/rpc'

/**
 * Readiness probe. 200 when this pod can serve a typical request; 503 only
 * when Redis is unreachable. Redis is the single hard gate — without it the
 * pod can't serve sessions or feeds. Base RPC is checked but NON-gating: it's
 * needed by only a few flows (mint verification, on-chain permission reads),
 * so a provider blip must not fail readiness and pull every pod from the LB,
 * darkening read-only browsing over a dependency most requests never touch
 * (SRE "Addressing Cascading Failures": don't let a non-essential dependency
 * flip the health check and cascade the outage). RPC trouble surfaces as
 * `degraded:true` for observability. Coolify reads the 503 to remove the pod
 * from the LB without restarting it (cf. /api/health for restart). Per-check
 * timeout so a hung TCP connection doesn't hold Coolify's probe open until its
 * own HTTP timeout fires.
 */
export const dynamic = 'force-dynamic'

const CHECK_TIMEOUT_MS = 3_000

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
    check('redis', () => redis.ping()),
    check('rpc', () => serverBaseClient().getBlockNumber()),
  ])
  // Redis is the only hard gate (see the module docstring). RPC failure is
  // reported as `degraded` but does NOT fail readiness — gating on it would
  // let a Base RPC blip evict every pod and cascade a full outage.
  const ready = redisCheck.ok
  const degraded = !rpcCheck.ok
  return NextResponse.json(
    { ready, degraded, redis: redisCheck, rpc: rpcCheck, timestamp: Date.now() },
    {
      status: ready ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  )
}
