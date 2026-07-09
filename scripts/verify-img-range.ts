// Verifies /api/img's byte-range ownership logic (lib/media/rangeContract).
//
// THE BUG IT GUARDS (VIDEO_PLAYBACK_RCA.md): iOS + macOS Safari probe every
// <video> with `Range: bytes=0-1` and refuse to play a source that answers
// 200 without Content-Range. When arweave.net's sandbox-redirect hosts serve
// rangeless 200s, the proxy must synthesize the 206 itself — these checks
// pin the synthesis math, the redirect domain-pinning that keeps the Range
// header applied at the final host, the HTML-fallback rejection that stops
// gateway landing pages from being cached as media, and the skip/cap stream.
//
// Run: node --experimental-strip-types scripts/verify-img-range.ts

import {
  countWithWindow,
  isHtmlFallback,
  parseRangeHeader,
  planSyntheticRange,
  redirectAllowed,
  skipCapStream,
} from '../lib/media/rangeContract.ts'
import { fetchGatewayResolved } from '../lib/media/gatewayFetch.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// ---- parseRangeHeader: the iOS probe + the forms we synthesize ----
check('parse bytes=0-1 (the AVFoundation probe)', eq(parseRangeHeader('bytes=0-1'), { start: 0, end: 1 }))
check('parse bytes=100- (open)', eq(parseRangeHeader('bytes=100-'), { start: 100, end: null }))
check('parse bytes=0-0', eq(parseRangeHeader('bytes=0-0'), { start: 0, end: 0 }))
check('parse is case-insensitive', eq(parseRangeHeader('BYTES=2-4'), { start: 2, end: 4 }))
check('suffix bytes=-500 parses', eq(parseRangeHeader('bytes=-500'), { start: 0, end: null, suffix: 500 }))
check('suffix bytes=-0 → null (zero-length suffix is invalid)', parseRangeHeader('bytes=-0') === null)
check('multi-range → null', parseRangeHeader('bytes=0-1,5-9') === null)
check('inverted bytes=5-4 → null', parseRangeHeader('bytes=5-4') === null)
check('garbage → null', parseRangeHeader('items=0-1') === null)
check('missing header → null', parseRangeHeader(null) === null)

// ---- planSyntheticRange: known total ----
check(
  'probe vs known total → bytes 0-1/100, CL 2',
  eq(planSyntheticRange({ start: 0, end: 1 }, 100), {
    kind: 'serve', start: 0, end: 1, contentRange: 'bytes 0-1/100', contentLength: 2,
  }),
)
check(
  'open range vs known total → clamps to end',
  eq(planSyntheticRange({ start: 10, end: null }, 100), {
    kind: 'serve', start: 10, end: 99, contentRange: 'bytes 10-99/100', contentLength: 90,
  }),
)
check(
  'end past EOF clamps',
  eq(planSyntheticRange({ start: 0, end: 999 }, 100), {
    kind: 'serve', start: 0, end: 99, contentRange: 'bytes 0-99/100', contentLength: 100,
  }),
)
check(
  'start at EOF → 416 with bytes */total',
  eq(planSyntheticRange({ start: 100, end: null }, 100), {
    kind: 'unsatisfiable', contentRange: 'bytes */100',
  }),
)

// ---- planSyntheticRange: unknown total (the degraded-sandbox case) ----
check(
  'probe vs unknown total → bytes 0-1/*, CL 2',
  eq(planSyntheticRange({ start: 0, end: 1 }, null), {
    kind: 'serve', start: 0, end: 1, contentRange: 'bytes 0-1/*', contentLength: 2,
  }),
)
check(
  'bounded mid-file range vs unknown total → best-effort 206',
  eq(planSyntheticRange({ start: 50, end: 59 }, null), {
    kind: 'serve', start: 50, end: 59, contentRange: 'bytes 50-59/*', contentLength: 10,
  }),
)
check('open range vs unknown total → full (no valid Content-Range exists)',
  eq(planSyntheticRange({ start: 100, end: null }, null), { kind: 'full' }))
check('open-from-zero vs unknown total → full',
  eq(planSyntheticRange({ start: 0, end: null }, null), { kind: 'full' }))
check(
  'suffix vs known total → tail window',
  eq(planSyntheticRange({ start: 0, end: null, suffix: 10 }, 100), {
    kind: 'serve', start: 90, end: 99, contentRange: 'bytes 90-99/100', contentLength: 10,
  }),
)
check(
  'suffix larger than file clamps to whole file',
  eq(planSyntheticRange({ start: 0, end: null, suffix: 500 }, 100), {
    kind: 'serve', start: 0, end: 99, contentRange: 'bytes 0-99/100', contentLength: 100,
  }),
)
check('suffix vs unknown total → full',
  eq(planSyntheticRange({ start: 0, end: null, suffix: 10 }, null), { kind: 'full' }))
check('suffix vs empty file → 416',
  eq(planSyntheticRange({ start: 0, end: null, suffix: 10 }, 0), { kind: 'unsatisfiable', contentRange: 'bytes */0' }))

// ---- isHtmlFallback ----
check('text/html rejected', isHtmlFallback('text/html'))
check('text/html; charset=utf-8 rejected', isHtmlFallback('text/html; charset=utf-8'))
check('video/mp4 accepted', !isHtmlFallback('video/mp4'))
check('absent content-type accepted', !isHtmlFallback(null))

// ---- redirectAllowed: pin the walk to the gateway's domain ----
const AR = 'https://arweave.net/SOME_TXID'
const sandbox = 'https://7evxmvvlenk56gky.arweave.net/SOME_TXID'
check('arweave sandbox subdomain allowed', redirectAllowed(AR, sandbox, AR)?.toString() === sandbox)
check('relative Location resolves within host', redirectAllowed(AR, '/raw/SOME_TXID', AR)?.toString() === 'https://arweave.net/raw/SOME_TXID')
check('cross-domain rejected', redirectAllowed(AR, 'https://evil.example/x', AR) === null)
check('cross-gateway-domain rejected (ipfs.io → dweb.link)',
  redirectAllowed('https://ipfs.io/ipfs/CID', 'https://cid.dweb.link/', 'https://ipfs.io/ipfs/CID') === null)
check('same-base subdomain allowed (dweb.link → cid.dweb.link)',
  redirectAllowed('https://dweb.link/ipfs/CID', 'https://cid.dweb.link/', 'https://dweb.link/ipfs/CID') !== null)
check('http downgrade rejected', redirectAllowed(AR, 'http://arweave.net/x', AR) === null)
check('credentials rejected', redirectAllowed(AR, 'https://u:p@arweave.net/x', AR) === null)
check('explicit port rejected', redirectAllowed(AR, 'https://arweave.net:8443/x', AR) === null)
check('IPv4 literal rejected', redirectAllowed(AR, 'https://10.0.0.1/x', AR) === null)
check('unparseable Location rejected', redirectAllowed(AR, 'https://', AR) === null)

// ---- skipCapStream: skip/emit math over chunk boundaries ----
function sourceOf(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]))
      else controller.close()
    },
  }).getReader()
}
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return out
    out += dec.decode(value, { stream: true })
  }
}

const body = ['abc', 'defg', 'hij'] // 10 bytes total
check('skip 2, emit 5 spans chunk boundaries',
  (await drain(skipCapStream(sourceOf(body), { skipBytes: 2, emitBytes: 5, maxTotalBytes: 1000 }))) === 'cdefg')
check('skip 0, emit to end',
  (await drain(skipCapStream(sourceOf(body), { skipBytes: 0, emitBytes: null, maxTotalBytes: 1000 }))) === 'abcdefghij')
check('skip an entire leading chunk exactly',
  (await drain(skipCapStream(sourceOf(body), { skipBytes: 3, emitBytes: 4, maxTotalBytes: 1000 }))) === 'defg')
check('skip past EOF yields empty',
  (await drain(skipCapStream(sourceOf(body), { skipBytes: 50, emitBytes: 5, maxTotalBytes: 1000 }))) === '')
check('emit cap larger than body yields remainder',
  (await drain(skipCapStream(sourceOf(body), { skipBytes: 8, emitBytes: 100, maxTotalBytes: 1000 }))) === 'ij')
const capped = await drain(
  skipCapStream(sourceOf(body), { skipBytes: 0, emitBytes: null, maxTotalBytes: 4 }),
).then(() => 'no-error', (e: unknown) => (e instanceof Error ? e.message : 'error'))
check('total-consumption cap errors the stream', capped === 'response exceeded size cap', capped)

// ---- countWithWindow: learn a real total from a lengthless stream ----
// The AVFoundation fix: `bytes 0-1/*` is rejected by iOS; the count reads a
// rangeless body to EOF once so the route can answer with the exact total.
{
  const r = await countWithWindow(sourceOf(body), {
    window: { start: 0, end: 1 }, maxBytes: 1000, maxMs: 5000,
  })
  check('count(0-1): exact total + 2-byte window',
    r.kind === 'counted' && r.total === 10 && new TextDecoder().decode(r.window) === 'ab', JSON.stringify(r))
}
{
  const r = await countWithWindow(sourceOf(body), {
    window: { start: 2, end: 6 }, maxBytes: 1000, maxMs: 5000,
  })
  check('count window spans chunk boundaries',
    r.kind === 'counted' && r.total === 10 && new TextDecoder().decode(r.window) === 'cdefg', JSON.stringify(r))
}
{
  const r = await countWithWindow(sourceOf(body), {
    window: { suffix: 4 }, maxBytes: 1000, maxMs: 5000,
  })
  check('count suffix ring keeps exactly the tail',
    r.kind === 'counted' && r.total === 10 && new TextDecoder().decode(r.window) === 'ghij', JSON.stringify(r))
}
{
  const r = await countWithWindow(sourceOf(body), {
    window: { start: 5, end: 20 }, maxBytes: 1000, maxMs: 5000,
  })
  check('count window clamped by EOF (end past file)',
    r.kind === 'counted' && r.total === 10 && new TextDecoder().decode(r.window) === 'fghij', JSON.stringify(r))
}
{
  const r = await countWithWindow(sourceOf(body), {
    window: { start: 0, end: 1 }, maxBytes: 4, maxMs: 5000,
  })
  check('count aborts on byte budget, window already complete',
    r.kind === 'aborted' && new TextDecoder().decode(r.window) === 'ab', JSON.stringify(r))
}

// ---- fetchGatewayResolved: the manual redirect walk, against a mock fetch ----
// Guards: the Range header reaching the FINAL host (the whole point — a range
// lost on the redirect hop is what iOS refuses), the final-URL cache fast
// path + stale-entry recovery, HTML-fallback rejection, and the hop cap.
interface Call { url: string; range: string | null }
function stubFetch(routes: Record<string, () => Response>, calls: Call[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, range: new Headers(init?.headers).get('range') })
    const make = routes[url]
    if (!make) throw new Error(`unexpected fetch: ${url}`)
    return make()
  }) as typeof fetch
}
const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } })
const video = () => new Response('vid', { status: 200, headers: { 'content-type': 'video/mp4' } })
const htmlPage = () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })
const notFound = () => new Response('nope', { status: 404 })
const signal = () => new AbortController().signal
const thrown = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof Error ? e.message : 'error'))

const GW = 'https://arweave.net/CACHED_TX'
const SANDBOX = 'https://abc123.arweave.net/CACHED_TX'
const SANDBOX2 = 'https://def456.arweave.net/CACHED_TX'

{
  // 1. Cold walk: 302 → sandbox, Range applied at BOTH hops, mapping cached.
  const calls: Call[] = []
  const r = await fetchGatewayResolved(GW, { range: 'bytes=0-1' }, signal(), stubFetch({ [GW]: redirect(SANDBOX), [SANDBOX]: video }, calls))
  check('walk follows 302 to the sandbox host', r.status === 200 && calls.length === 2 && calls[1].url === SANDBOX)
  check('Range header reaches the final host', calls[1].range === 'bytes=0-1', JSON.stringify(calls))
}
{
  // 2. Warm cache: goes straight to the final host, one fetch total.
  const calls: Call[] = []
  const r = await fetchGatewayResolved(GW, { range: 'bytes=5-9' }, signal(), stubFetch({ [SANDBOX]: video }, calls))
  check('cached final URL skips the redirect hop', r.status === 200 && calls.length === 1 && calls[0].url === SANDBOX && calls[0].range === 'bytes=5-9', JSON.stringify(calls))
}
{
  // 3. Stale cache: cached final now 404s → re-walk from the gateway root
  //    lands on the new sandbox and overwrites the mapping.
  const calls: Call[] = []
  const r = await fetchGatewayResolved(GW, undefined, signal(), stubFetch({ [SANDBOX]: notFound, [GW]: redirect(SANDBOX2), [SANDBOX2]: video }, calls))
  check('stale cached mapping re-walks from the root', r.status === 200 && calls.map((c) => c.url).join(' → ') === `${SANDBOX} → ${GW} → ${SANDBOX2}`, calls.map((c) => c.url).join(' → '))
}
check('HTML fallback page is a loss, not a win',
  (await thrown(fetchGatewayResolved('https://arweave.net/HTML_TX', undefined, signal(), stubFetch({ 'https://arweave.net/HTML_TX': htmlPage }, [])))) === 'gateway served HTML fallback page')
check('redirect leaving the gateway domain is rejected',
  (await thrown(fetchGatewayResolved('https://arweave.net/EVIL_TX', undefined, signal(), stubFetch({ 'https://arweave.net/EVIL_TX': redirect('https://evil.example/x') }, [])))) !== null)
check('HTTP error status is a loss',
  (await thrown(fetchGatewayResolved('https://arweave.net/MISSING_TX', undefined, signal(), stubFetch({ 'https://arweave.net/MISSING_TX': notFound }, [])))) === 'gateway status 404')
{
  // Hop cap: a 4-deep chain within the domain exceeds MAX_REDIRECT_HOPS.
  const base = 'https://arweave.net/LOOP_TX'
  const hop = (n: number) => `https://h${n}.arweave.net/LOOP_TX`
  const routes: Record<string, () => Response> = { [base]: redirect(hop(1)) }
  for (let n = 1; n <= 4; n++) routes[hop(n)] = redirect(hop(n + 1))
  check('redirect chains past the hop cap are abandoned',
    (await thrown(fetchGatewayResolved(base, undefined, signal(), stubFetch(routes, [])))) === 'too many redirects')
}

if (failures > 0) {
  console.error(`\n${failures} img-range check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll img-range checks passed.')
