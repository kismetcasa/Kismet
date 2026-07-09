import { NextResponse, type NextRequest } from 'next/server'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'

/**
 * Sink for client-side diagnostic reports (see lib/clientError.ts). The app
 * has no error-tracking service, so this is the one place a browser failure
 * becomes a server-side log line we can read and grep ("[client-error]").
 *
 * Deliberately minimal and defensive: it never trusts the body shape, caps
 * the size, and always returns 204 so a noisy or malicious client can't turn
 * logging itself into an error path.
 */
export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = 16 * 1024

export async function POST(req: NextRequest) {
  // Rate-limit the anonymous sink so it can't be used to flood server logs
  // (storage/observability cost). Over-limit reports are dropped with the same
  // 204 the route always returns — logging must never become an error path.
  if (!(await checkRateLimit(`client-error:${getClientIp(req)}`, 30, 60))) {
    return new NextResponse(null, { status: 204 })
  }
  try {
    const text = await req.text()
    if (text.length > MAX_BODY_BYTES) {
      console.warn('[client-error] dropped oversized report', { bytes: text.length })
      return new NextResponse(null, { status: 204 })
    }
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      return new NextResponse(null, { status: 204 })
    }
    console.error('[client-error]', JSON.stringify(payload))
  } catch {
    // Never let logging fail loudly.
  }
  return new NextResponse(null, { status: 204 })
}
