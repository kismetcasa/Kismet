import { NextResponse } from 'next/server'

/**
 * Shared error envelope for API route handlers. Use in place of
 *   NextResponse.json({ error: msg }, { status: code })
 * Routes that need extra fields (e.g. mint-proxy's structured
 * AUTHORIZE_REQUIRED, distribute's upstream `detail`) still build a
 * NextResponse directly so the extra shape stays visible at the call site.
 */
export function errorResponse(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status })
}
