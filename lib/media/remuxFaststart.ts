import { getFFmpeg } from './transcodeGif'

const MAX_SOURCE_BYTES = 100 * 1024 * 1024

// `-c copy` to .mp4 only works when the source codecs are MP4-compatible
// (H.264/HEVC + AAC). WebM (VP8/VP9 + Opus) and AVI/MKV are excluded;
// remuxing those would require a real re-encode.
const REMUXABLE_TYPES = new Map<string, string>([
  ['video/mp4', 'mp4'],
  ['video/quicktime', 'mov'],
  ['video/x-m4v', 'm4v'],
])

/**
 * Lossless container rewrite that moves the moov atom to the file start
 * (`-movflags +faststart`) so the browser can begin playback after a few
 * KB rather than probing the whole file for metadata. `-c copy` skips
 * any bitstream re-encode, so the operation completes in seconds and
 * quality is preserved exactly. Returns null on any failure so the
 * caller can fall back to uploading the source unchanged.
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
