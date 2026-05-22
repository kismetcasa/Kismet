import type { LogEvent } from '@ffmpeg/ffmpeg'
import { getFFmpeg } from './transcodeGif'

const MAX_SOURCE_BYTES = 100 * 1024 * 1024

/**
 * Probe a video file for its duration in seconds via the existing
 * ffmpeg.wasm singleton. Returns null on any read error so callers can
 * skip the durationSec field in the mint payload — SharedVideoProvider
 * falls back to its current loadedmetadata-driven tier detection when
 * the field is absent.
 *
 * Cost: ~200-800ms per file depending on size. Run in parallel with
 * the upload so it doesn't extend perceived mint latency. Files larger
 * than MAX_SOURCE_BYTES skip the probe — ffmpeg.wasm OOMs on phones
 * past that bound and the same threshold gates the remux pass.
 */
export async function probeDurationSeconds(file: File): Promise<number | null> {
  if (!file.type.startsWith('video/')) return null
  if (file.size > MAX_SOURCE_BYTES) return null

  const ext = (file.name.split('.').pop() ?? 'bin').toLowerCase().replace(/[^a-z0-9]/g, '')
  const input = `probe.${ext || 'bin'}`

  const ff = await getFFmpeg()
  let durationSec: number | null = null
  const onLog = ({ message }: LogEvent) => {
    const m = message.match(/Duration: (\d+):(\d+):(\d+\.\d+)/)
    if (m) durationSec = +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3])
  }
  try {
    await ff.writeFile(input, new Uint8Array(await file.arrayBuffer()))
    ff.on('log', onLog)
    // `ffmpeg -i <input>` with no output produces a nonzero exit + writes
    // the Duration line to stderr. Suppress the exit so the catch in the
    // caller doesn't swallow a successfully-probed value.
    await ff.exec(['-i', input]).catch(() => {})
  } catch {
    return null
  } finally {
    ff.off('log', onLog)
    try { await ff.deleteFile(input) } catch {}
  }
  return durationSec
}
