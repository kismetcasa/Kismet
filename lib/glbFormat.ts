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
