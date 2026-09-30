import { NextRequest, NextResponse, after } from 'next/server'
import crypto from 'node:crypto'
import { runStatsPipeline } from '@/lib/statsPipeline'
import { errorResponse } from '@/lib/apiResponse'

export const dynamic = 'force-dynamic'
// A full /transfers scan can run long. We kick it off AFTER the response so a
// reverse proxy (Vercel, or Coolify/Traefik) can't time the request out and
// return 502 mid-scan. maxDuration is a Vercel-only hint; on a persistent server
// (Coolify) the after() callback runs to completion regardless.
export const maxDuration = 300

// Runs the stats pipeline (lib/statsPipeline). Scheduled via a cron (Vercel
// `crons` in vercel.json, OR — on Coolify — a Scheduled Task / external
// scheduler hitting this URL); without any scheduler the app runs the same
// pipeline itself once its heartbeat is an hour old (lib/backgroundTasks), so
// this route is an accelerator, never a prerequisite. Also callable manually.
// Protected by CRON_SECRET, sent as `Authorization: Bearer <secret>` (Vercel
// cron does this automatically) or `?secret=`. The compare is trimmed so a stray newline/space in the stored
// env var can't cause a spurious 401.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return errorResponse(500, 'CRON_SECRET not configured')

  const auth = req.headers.get('authorization')
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null
  const provided = (bearer ?? new URL(req.url).searchParams.get('secret') ?? '').trim()
  // Constant-time compare, length-checked so timingSafeEqual can't throw on a
  // size mismatch (mirrors the Alchemy webhook route, which this one didn't).
  const providedBuf = Buffer.from(provided)
  const secretBuf = Buffer.from(secret.trim())
  if (providedBuf.length !== secretBuf.length || !crypto.timingSafeEqual(providedBuf, secretBuf)) {
    return errorResponse(401, 'Unauthorized')
  }

  // Respond immediately; run the pipeline in the background (lib/statsPipeline —
  // the same function the in-process fallback in lib/backgroundTasks drives when
  // nothing has called this route for an hour). The result goes to the server
  // logs, since the HTTP response returns before it finishes.
  after(runStatsPipeline)

  return NextResponse.json({ ok: true, started: true })
}
