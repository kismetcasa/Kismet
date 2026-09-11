import type { AgentActionEnvelope } from './types'

/**
 * Human rendering of a prepare envelope for a browser NAVIGATION to a GET
 * prepare URL — the user on a chat-only surface who taps the link the
 * assistant asked them to paste back, instead of copying it. Same content as
 * the JSON (the envelope is embedded verbatim) plus the summary and, when the
 * envelope carries one, the Base app approve link.
 *
 * Served only when the request is a document navigation — `Sec-Fetch-Dest:
 * document`, which browsers send on navigations and server-side fetchers do
 * not — and `format=json` is absent, so assistants and tools keep receiving
 * JSON. Errors stay JSON on every path.
 */
export function isDocumentNavigation(req: { headers: Headers; nextUrl: { searchParams: URLSearchParams } }): boolean {
  if (req.nextUrl.searchParams.get('format') === 'json') return false
  return req.headers.get('sec-fetch-dest') === 'document'
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

export function renderApprovePage(envelope: AgentActionEnvelope, backUrl: string): string {
  const approve = envelope.link
    ? `<p><a class="btn" href="${esc(envelope.link.url)}">Approve in the Base app</a></p>`
    : `<p class="dim">No Base app link for this action — approve it through your assistant.</p>`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Kismet — ${esc(envelope.action)}</title>
<style>body{margin:0;padding:24px 16px;background:#111;color:#eee;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}main{max-width:640px;margin:0 auto}h1{font-size:14px;letter-spacing:.1em;text-transform:uppercase;margin:0 0 16px}p{margin:0 0 16px}.btn{display:inline-block;padding:10px 16px;background:#eee;color:#111;text-decoration:none;text-transform:uppercase;letter-spacing:.1em;font-size:12px}a{color:#bbb}.dim{color:#999}details{margin-top:24px}summary{cursor:pointer;color:#999}pre{overflow:auto;font-size:11px;color:#bbb;background:#181818;padding:12px}</style></head>
<body><main><h1>Kismet</h1><p>${esc(envelope.summary)}</p>${approve}<p><a href="${esc(backUrl)}">View on Kismet</a></p><details><summary>Envelope (JSON)</summary><pre>${esc(JSON.stringify(envelope, null, 2))}</pre></details></main></body></html>`
}

export function approvePageResponse(envelope: AgentActionEnvelope, backUrl: string): Response {
  return new Response(renderApprovePage(envelope, backUrl), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' },
  })
}
