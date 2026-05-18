import { getFFmpeg } from './transcodeGif'

// Skip on anything large enough to OOM ffmpeg.wasm on phones (same
// ceiling the GIF transcoder uses).
const MAX_SOURCE_BYTES = 100 * 1024 * 1024

// Only attempt the lossless `-c copy` remux on containers whose codecs
// are guaranteed to be MP4-compatible (H.264/HEVC + AAC). WebM (VP8/VP9
// + Opus/Vorbis) is excluded — `-c copy` to .mp4 fails for those, and
// re-encoding belongs to a future, heavier transcode path. AVI/MKV
// similarly skipped: too variable to assume codec compatibility.
const REMUXABLE_TYPES = new Map<string, string>([
  ['video/mp4', 'mp4'],
  ['video/quicktime', 'mov'],
  ['video/x-m4v', 'm4v'],
])

/**
 * Lossless container rewrite — moves the moov atom from the end of the
 * file to the front (`-movflags +faststart`) so a browser can begin
 * playback after the first few KB of download instead of byte-range
 * probing the whole file to find metadata. Critical on Safari, which
 * does the probe sequentially and visibly stalls the first paint when
 * the moov is at the end.
 *
 * `-c copy` means no re-encode: video + audio bitstreams are copied
 * byte-for-byte, so quality is preserved exactly and the operation
 * completes in seconds (vs. minutes for a re-encode). Bails to null
 * on any failure — unsupported codec combo, ffmpeg error, OOM —
 * so the caller can fall back to uploading the source unchanged.
 *
 * Note: only helps videos uploaded AFTER this ships. Existing Arweave
 * videos are immutable and stuck with whatever moov ordering their
 * source encoder produced.
 */
export async function remuxToFaststartMp4(file: File): Promise<File | null> {
  if (file.size > MAX_SOURCE_BYTES) return null
  const ext = REMUXABLE_TYPES.get(file.type)
  if (!ext) return null

  const inputName = `in.${ext}`
  const outputName = 'out.mp4'

  const ff = await getFFmpeg()
  try {
    await ff.writeFile(inputName, new Uint8Array(await file.arrayBuffer()))
    await ff.exec([
      '-i', inputName,
      '-c', 'copy',
      '-movflags', '+faststart',
      outputName,
    ])
    const bytes = (await ff.readFile(outputName)) as Uint8Array
    if (bytes.byteLength === 0) return null
    const base = file.name.replace(/\.[^.]+$/, '') || 'media'
    return new File([bytes as BlobPart], `${base}.mp4`, { type: 'video/mp4' })
  } catch {
    return null
  } finally {
    for (const f of [inputName, outputName]) {
      try { await ff.deleteFile(f) } catch {}
    }
  }
}
