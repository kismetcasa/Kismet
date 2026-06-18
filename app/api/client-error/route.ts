import { NextResponse, type NextRequest } from 'next/server'

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
