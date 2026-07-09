import { NextResponse } from 'next/server'
import { backfillMomentIndex } from '@/lib/airdrops'
import { verifyAdminSession } from '@/lib/curator'
import { errorResponse } from '@/lib/apiResponse'

/**
 * One-shot admin backfill: populate the per-moment airdrop reverse index from
 * the existing per-sender logs. recordAirdrop writes both indices going
 * forward, so this only needs to run once to surface airdrops recorded before
 * the reverse index existed (e.g. moments already airdropped) in the
 * per-moment activity feed. Idempotent — safe to re-run.
 *
 * POST (no body). Admin-gated.
 */
export async function POST() {
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  try {
    const result = await backfillMomentIndex()
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    return errorResponse(
      500,
      `Reindex failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
