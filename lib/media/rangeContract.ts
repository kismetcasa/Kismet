// Byte-range ownership for the /api/img media proxy — the pure logic, kept
// framework-free so scripts/verify-img-range.ts can exercise every branch
// without Next/sharp in the loop.
//
// WHY THIS EXISTS (see VIDEO_PLAYBACK_RCA.md): iOS/macOS AVFoundation opens
// every <video> with a `Range: bytes=0-1` probe and refuses to play a source
// whose server answers it with a plain 200 — Apple documents byte-range
// support as a hard requirement for progressive playback. The proxy used to
// forward Range and pass through whatever the gateway race returned, on the
// (Chromium-only) assumption that a 200-with-full-body is a tolerable answer
// to a ranged request. arweave.net's serving stack now 302s data items to
// sandbox hosts whose responses can drop range support entirely, so every
// WebKit surface (all of iOS, desktop Safari, Mini App webviews) — which is
// exactly the population routed through this proxy by videoGatewayUrls —
// received unplayable responses. These helpers let the route guarantee the
// range contract itself: honor upstream 206s verbatim, and when upstream
// ignores the range, synthesize the 206 by skipping/capping the stream.

export interface ParsedRange {
  start: number
  /** Inclusive end byte, or null for an open-ended `bytes=start-` request. */
  end: number | null
  /** Set for suffix form `bytes=-N` (last N bytes); start/end are then
   *  placeholders resolved against the total in planSyntheticRange. */
  suffix?: number
}

/**
 * Parse a Range header into the single bounded/open/suffix forms we can
 * synthesize. Returns null for anything else — no header, multi-range
 * lists, non-byte units, or malformed values. Callers still forward the
 * RAW header upstream regardless (a range-capable upstream can honor forms
 * we don't synthesize, and its 206 passes through verbatim); this parse
 * only gates the synthesis fallback.
 */
export function parseRangeHeader(value: string | null | undefined): ParsedRange | null {
  if (!value) return null
  const trimmed = value.trim()
  const suffix = /^bytes=-(\d+)$/i.exec(trimmed)
  if (suffix) {
    const n = Number(suffix[1])
    if (!Number.isSafeInteger(n) || n <= 0) return null
    return { start: 0, end: null, suffix: n }
  }
  const m = /^bytes=(\d+)-(\d*)$/i.exec(trimmed)
  if (!m) return null
  const start = Number(m[1])
  if (!Number.isSafeInteger(start)) return null
  if (!m[2]) return { start, end: null }
  const end = Number(m[2])
  if (!Number.isSafeInteger(end) || end < start) return null
  return { start, end }
}

export type RangePlan =
  /** Emit a synthesized 206: skip `start` bytes, send `contentLength` bytes. */
  | { kind: 'serve'; start: number; end: number; contentRange: string; contentLength: number }
  /** Range starts past the end of a known-length resource → 416. */
  | { kind: 'unsatisfiable'; contentRange: string }
  /** Can't build a valid Content-Range (open range, unknown total) — serve
   *  the full 200 instead, which RFC 9110 permits (a server MAY ignore Range). */
  | { kind: 'full' }

/**
 * Decide how to answer a ranged request when the upstream ignored the range
 * (returned 200). `totalBytes` is the upstream-declared length when known.
 *
 * With a known total this is fully spec-shaped: clamp, 416 when the start is
 * past the end. With an unknown total (chunked upstreams — the degraded
 * arweave sandbox case) a bounded range still gets a best-effort 206 with a
 * `/*` total, which satisfies AVFoundation's probe; an open-ended range has
 * no expressible Content-Range, so it degrades to the full body.
 */
export function planSyntheticRange(range: ParsedRange, totalBytes: number | null): RangePlan {
  if (totalBytes != null) {
    // Suffix form resolves against the total: last N bytes.
    if (range.suffix != null) {
      if (totalBytes === 0) return { kind: 'unsatisfiable', contentRange: `bytes */0` }
      const start = Math.max(0, totalBytes - range.suffix)
      return {
        kind: 'serve',
        start,
        end: totalBytes - 1,
        contentRange: `bytes ${start}-${totalBytes - 1}/${totalBytes}`,
        contentLength: totalBytes - start,
      }
    }
    if (range.start >= totalBytes) {
      return { kind: 'unsatisfiable', contentRange: `bytes */${totalBytes}` }
    }
    const end = Math.min(range.end ?? totalBytes - 1, totalBytes - 1)
    return {
      kind: 'serve',
      start: range.start,
      end,
      contentRange: `bytes ${range.start}-${end}/${totalBytes}`,
      contentLength: end - range.start + 1,
    }
  }
  // Total unknown: suffix ranges are unresolvable (we don't know where the
  // end is), and AVFoundation rejects `*` totals anyway — the route's
  // count-through path exists to make this branch rare.
  if (range.suffix != null) return { kind: 'full' }
  if (range.end != null) {
    return {
      kind: 'serve',
      start: range.start,
      end: range.end,
      contentRange: `bytes ${range.start}-${range.end}/*`,
      contentLength: range.end - range.start + 1,
    }
  }
  return { kind: 'full' }
}

/**
 * A gateway answering a data-item fetch with an HTML page is serving its
 * landing/propagation fallback, not the content — ar://+ipfs:// bytes are
 * never legitimately text/html on Kismet's render paths (images, gifs,
 * video). Treating it as a win used to cache the HTML under the media URL
 * with a 1-year immutable header — the poison observed live in the RCA.
 */
export function isHtmlFallback(contentType: string | null): boolean {
  return !!contentType && contentType.toLowerCase().startsWith('text/html')
}

/**
 * Validate a redirect hop for the gateway fetch. `original` is the gateway
 * URL the walk started from; `location` is the Location header resolved
 * against `current` (the hop that issued it).
 *
 * Policy: https only, no credentials, no explicit port, no IP-literal hosts,
 * and the target must stay within the ORIGINAL gateway's registrable domain
 * (arweave.net → *.arweave.net covers the sandbox-subdomain redirect;
 * dweb.link → <cid>.dweb.link likewise). This is strictly tighter than the
 * blind `redirect: 'follow'` it replaces — a compromised/misbehaving gateway
 * can no longer bounce the proxy to an arbitrary origin (SSRF hygiene).
 */
export function redirectAllowed(
  original: string | URL,
  location: string,
  current: string | URL,
): URL | null {
  let target: URL
  try {
    target = new URL(location, current)
  } catch {
    return null
  }
  if (target.protocol !== 'https:') return null
  if (target.username || target.password || target.port) return null
  const host = target.hostname
  // IP literals (v4 dotted or v6 bracketed) never appear in the gateway
  // pool's redirect space; rejecting them closes the internal-address class.
  if (/^[\d.]+$/.test(host) || host.includes(':')) return null
  const base = registrableDomain(new URL(original).hostname)
  if (!base) return null
  return host === base || host.endsWith(`.${base}`) ? target : null
}

// Last two labels — exact for every pool host (arweave.net, ipfs.io,
// dweb.link). Revisit if a gateway on a multi-label public suffix
// (e.g. *.co.uk) ever joins the pool.
function registrableDomain(hostname: string): string | null {
  const labels = hostname.split('.').filter(Boolean)
  if (labels.length < 2) return null
  return labels.slice(-2).join('.')
}

export type CountResult =
  /** EOF reached: `total` is the file's exact size; `window` holds the
   *  requested byte window (start-form) or the tail ring (suffix-form). */
  | { kind: 'counted'; total: number; window: Uint8Array }
  /** Budget exceeded before EOF. `window` may be complete (start-form
   *  windows fill early) — callers check its length before serving. */
  | { kind: 'aborted'; window: Uint8Array; consumed: number }

/**
 * Read `reader` to EOF, counting total bytes while buffering ONLY the
 * requested window — the mechanism that turns a lengthless chunked upstream
 * (no Content-Length, ranges ignored) into a real `Content-Range` total.
 * AVFoundation rejects `bytes 0-1/*`; it needs the actual size, and for
 * content-addressed media the size is immutable, so ONE bounded count per
 * URI (cached by the route) fixes every subsequent request.
 *
 * Window forms: `{start,end}` buffers that inclusive slice as it streams
 * past; `{suffix}` keeps a rolling tail of the last N bytes. Both are
 * bounded by the caller (the route gates count-through on small windows).
 * `maxMs`/`maxBytes` bound the read; on exceed the upstream is cancelled
 * and the caller falls back to the best-effort `*` answer.
 */
export async function countWithWindow(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  opts: {
    window: { start: number; end: number } | { suffix: number }
    maxBytes: number
    maxMs: number
  },
): Promise<CountResult> {
  const deadline = Date.now() + opts.maxMs
  const isSuffix = 'suffix' in opts.window
  const wStart = isSuffix ? 0 : (opts.window as { start: number }).start
  const wEnd = isSuffix ? -1 : (opts.window as { end: number }).end
  const suffixN = isSuffix ? (opts.window as { suffix: number }).suffix : 0

  const parts: Uint8Array[] = []
  let partsBytes = 0
  let consumed = 0

  const finishWindow = (): Uint8Array => {
    const joined = new Uint8Array(partsBytes)
    let o = 0
    for (const p of parts) {
      joined.set(p, o)
      o += p.byteLength
    }
    // Tail ring keeps ≥ suffixN bytes; trim the front to exactly N.
    return isSuffix && joined.byteLength > suffixN
      ? joined.subarray(joined.byteLength - suffixN)
      : joined
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) return { kind: 'counted', total: consumed, window: finishWindow() }
    const chunkStart = consumed
    consumed += value.byteLength

    if (isSuffix) {
      parts.push(value)
      partsBytes += value.byteLength
      // Drop whole leading chunks while the ring still holds ≥ suffixN.
      while (parts.length > 1 && partsBytes - parts[0].byteLength >= suffixN) {
        partsBytes -= parts[0].byteLength
        parts.shift()
      }
    } else if (chunkStart <= wEnd && consumed - 1 >= wStart) {
      // Overlap of [chunkStart, consumed-1] with [wStart, wEnd].
      const from = Math.max(wStart - chunkStart, 0)
      const to = Math.min(wEnd - chunkStart, value.byteLength - 1)
      const slice = value.subarray(from, to + 1)
      parts.push(slice)
      partsBytes += slice.byteLength
    }

    if (consumed > opts.maxBytes || Date.now() > deadline) {
      void reader.cancel().catch(() => {})
      return { kind: 'aborted', window: finishWindow(), consumed }
    }
  }
}

/**
 * Stream `reader` while skipping the first `skipBytes` and emitting at most
 * `emitBytes` (null = to the end). `maxTotalBytes` bounds TOTAL upstream
 * consumption (skipped + emitted) the same way passthroughStream bounds the
 * plain path, so a synthesized range can never pull more than the route's
 * global cap. Memory stays flat: chunks are sliced through under client
 * backpressure, never accumulated; the upstream is cancelled as soon as the
 * emit cap is reached.
 */
export function skipCapStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  opts: { skipBytes: number; emitBytes: number | null; maxTotalBytes: number },
): ReadableStream<Uint8Array> {
  let toSkip = opts.skipBytes
  let remaining = opts.emitBytes
  let consumed = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Loop until we enqueue something, close, or error — a pull that
      // returns without any of those stalls the consumer forever.
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        consumed += value.byteLength
        if (consumed > opts.maxTotalBytes) {
          controller.error(new Error('response exceeded size cap'))
          void reader.cancel().catch(() => {})
          return
        }
        let chunk = value
        if (toSkip > 0) {
          if (chunk.byteLength <= toSkip) {
            toSkip -= chunk.byteLength
            continue
          }
          chunk = chunk.subarray(toSkip)
          toSkip = 0
        }
        if (remaining != null) {
          if (chunk.byteLength >= remaining) {
            controller.enqueue(chunk.subarray(0, remaining))
            remaining = 0
            controller.close()
            void reader.cancel().catch(() => {})
            return
          }
          remaining -= chunk.byteLength
        }
        controller.enqueue(chunk)
        return
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {})
    },
  })
}
