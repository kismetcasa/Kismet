// `next/server` for scripts/e2e/drops-flow.ts: Next's real request and
// response classes, with `after` run on the microtask queue — there is no
// request scope outside Next's server, and the verify loader shims `after`
// the same way (scripts/ts-alias-hooks.mjs).
import server from 'next/server.js'

export const { NextRequest, NextResponse, ImageResponse, userAgent, userAgentFromString, URLPattern, connection } = server
export const after = (task) => {
  Promise.resolve().then(() => (typeof task === 'function' ? task() : task))
}
