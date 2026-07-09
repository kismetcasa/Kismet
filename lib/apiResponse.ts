import { NextResponse } from 'next/server'

/**
 * Standard `{ error }` envelope for API routes. Routes that need extra
 * fields (AUTHORIZE_REQUIRED, upstream `detail`) build NextResponse directly.
 */
export function errorResponse(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status })
}

/**
 * Error envelope for failures raised by an INFRASTRUCTURE dependency (RPC,
 * Turbo, Redis, an upstream fetch). Logs the real error server-side and
 * returns only `clientMessage` to the caller — a raw `err.message` from viem
 * embeds the full request URL (leaking the server-only RPC key on the public
 * agent routes) and lets a caller use error text as a status/host oracle.
 * Use for catches that wrap a dependency call; keep plain errorResponse for
 * app-logic messages that are safe (and useful) to return.
 */
export function upstreamError(
  status: number,
  clientMessage: string,
  err: unknown,
  label = 'api',
): NextResponse {
  console.error(`[${label}]`, err instanceof Error ? (err.stack ?? err.message) : String(err))
  return NextResponse.json({ error: clientMessage }, { status })
}
