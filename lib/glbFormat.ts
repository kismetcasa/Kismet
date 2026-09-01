/**
 * The GLB (Binary glTF) format identity — extension, MIME, magic bytes — in
 * ONE place, because TWO features accept `.glb` and they must agree:
 *
 *   - primary mint media (lib/media/modelMedia, MintForm, the 3D viewer)
 *   - collector downloads (lib/collectorFileTypes -> lib/collectorFileCore)
 *
 * An artist who drops the same file into the MEDIA slot and the collector-
 * download slot must get the same verdict on what it is; a second definition
 * could only ever drift apart. These are SPEC constants — the IANA
 * `model/gltf-binary` registration and the glTF 2.0 header magic — not
 * per-feature choices, so there is nothing here for a feature to own
 * privately.
 *
 * Client-safe by construction: zero imports, no Node built-ins, no DOM. The
 * mint form sniffs with it in the browser; collectorFileCore builds its
 * server-side detection registry from it.
 */

export const GLB_EXT = '.glb'

/** IANA-registered media type for Binary glTF. */
export const GLB_MIME = 'model/gltf-binary'

/** glTF 2.0 header: ASCII "glTF" (0x46546C67 little-endian) at byte 0. */
export const GLB_MAGIC: readonly number[] = [0x67, 0x6c, 0x54, 0x46]

/**
 * Magic-byte test — the ONLY trustworthy answer to "is this a GLB?".
 * A claimed extension and a browser-supplied `File.type` are both caller
 * -controlled (and `.glb` has no registered browser MIME, so `File.type` is
 * the empty string for a real GLB anyway).
 */
export function hasGlbMagic(head: Uint8Array): boolean {
  return head.length >= GLB_MAGIC.length && GLB_MAGIC.every((b, i) => head[i] === b)
}

/** Bytes in the glTF 2.0 header: magic(4) + version(4) + length(4). */
export const GLB_HEADER_BYTES = 12

/**
 * Read the glTF 2.0 header. Null when the bytes aren't a GLB at all.
 *
 * The magic alone answers "is this a GLB", which is all the collector-file
 * detector needs — it stores and re-serves bytes it never parses. A file
 * about to be MINTED is different: it gets uploaded to permanent storage and
 * written into token metadata, so a truncated export that fails four bytes
 * later is worth catching at pick time rather than after the artist has
 * spent Arweave credits on it. The header carries exactly the two extra
 * facts needed for that — see isWellFormedGlbHeader.
 */
export function readGlbHeader(
  head: Uint8Array,
): { version: number; declaredLength: number } | null {
  if (!hasGlbMagic(head) || head.length < GLB_HEADER_BYTES) return null
  // Little-endian uint32s per the spec. byteOffset matters: a Uint8Array
  // taken from a larger buffer is a view, not the buffer's start.
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  return { version: view.getUint32(4, true), declaredLength: view.getUint32(8, true) }
}

/**
 * Is this a GLB we can actually expect to render, given its total size?
 *
 * Two checks, each rejecting a file that would otherwise mint and only then
 * fail in the viewer:
 *   - version must be 2. glTF 1.0 binary used a different chunk layout that
 *     three.js (and so model-viewer) does not read.
 *   - the header's declared total length must not EXCEED the real byte
 *     count, which is the signature of a truncated or interrupted export.
 *     Deliberately `<=`, not `==`: the spec says the two are equal, but a
 *     trailing-padded file still loads fine and rejecting it would be
 *     stricter than the renderer.
 */
export function isWellFormedGlbHeader(head: Uint8Array, totalBytes: number): boolean {
  const header = readGlbHeader(head)
  if (!header) return false
  return header.version === 2 && header.declaredLength > 0 && header.declaredLength <= totalBytes
}
