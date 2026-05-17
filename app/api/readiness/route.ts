import { NextResponse } from 'next/server'
import { redis } from '@/lib/redis'
import { serverBaseClient } from '@/lib/rpc'

/**
 * Readiness probe. 200 when this pod can serve a typical request; 503
 * when Redis or the Base RPC is unreachable. Coolify reads the 503 to
 * remove the pod from the LB without restarting it (cf. /api/health for
 * restart). Per-check timeout so a hung TCP connection doesn't hold
 * Coolify's probe open until its own HTTP timeout fires.
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
  const ready = redisCheck.ok && rpcCheck.ok
  return NextResponse.json(
    { ready, redis: redisCheck, rpc: rpcCheck, timestamp: Date.now() },
    {
      status: ready ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  )
}
