/**
 * Read a fetch Response body fully into a Buffer, enforcing `maxBytes` on
 * ACTUAL bytes read. Content-Length is advisory: chunked upstreams (common
 * for IPFS/Arweave gateways) omit it entirely, and a misbehaving one can
 * under-report — so any cap gated on the header alone lets an unbounded body
 * straight into RAM (OWASP API4:2023 Unrestricted Resource Consumption).
 *
 * On overflow the caller gets the chunks read so far plus the LIVE reader and
 * must either resume it (splice the prefix into a streaming passthrough, as
 * /api/img does) or cancel it (release the connection, as colorExtract does).
 */
export async function readBodyBounded(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<
  | { kind: 'complete'; buffer: Buffer }
  | { kind: 'overflow'; chunks: Uint8Array[]; reader: ReadableStreamDefaultReader<Uint8Array> }
> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
    if (total > maxBytes) return { kind: 'overflow', chunks, reader }
  }
  return { kind: 'complete', buffer: Buffer.concat(chunks) }
}
