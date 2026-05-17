import { NextResponse } from 'next/server'

/**
 * Liveness probe. Always 200 — restart is only the right remediation
 * for a wedged Node process. External-dep failures (Redis, RPC) fail
 * /api/readiness instead, which removes the pod from the LB without
 * the restart-storm-across-every-pod problem.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(
    { ok: true, timestamp: Date.now() },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
