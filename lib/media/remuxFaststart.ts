import type { LogEvent } from '@ffmpeg/ffmpeg'
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

// Strict threshold so true audio art is never stripped. -50dB peak across
// the entire duration only matches a track that's effectively dead air —
// ambient noise, breath room tone, and most "quiet" music all sit
// comfortably louder. 0.5s minimum silence run avoids false negatives
// from inter-frame microsilences in compressed audio.
const SILENCE_THRESHOLD_DB = -50
const SILENCE_MIN_RUN_S = 0.5
// Treat 98% silent as fully silent — leaves room for a single sub-second
// transient (codec artifact, leading frame noise) without preserving
// audio for tracks that are 99.5% dead.
const SILENT_COVERAGE_RATIO = 0.98

/**
 * Probe an audio track for sustained silence. Returns true when the track
 * is dead-air across (effectively) its entire duration so the remux can
 * drop it with `-an`. Returns false on any read error so we never strip
 * audio we couldn't positively classify as silent. Adds ~500ms–1.5s to
 * mint time for videos with audio tracks.
 */
async function isAudioSilent(
  ff: Awaited<ReturnType<typeof getFFmpeg>>,
  input: string,
): Promise<boolean> {
  let durationSec = 0
  let totalSilenceSec = 0
  let hasAudio = false
  const onLog = ({ message }: LogEvent) => {
    // Audio stream presence — ffmpeg prints "Stream #0:1 ... Audio: …"
    // on the input probe. No audio = nothing to strip; we want to return
    // false so the caller skips the -an branch (passing -an to a video
    // without audio is a no-op but the probe pass is wasted either way).
    if (/Stream #\d+:\d+.*Audio:/.test(message)) hasAudio = true
    const dm = message.match(/Duration: (\d+):(\d+):(\d+\.\d+)/)
    if (dm) durationSec = +dm[1] * 3600 + +dm[2] * 60 + parseFloat(dm[3])
    const sm = message.match(/silence_duration: ([\d.]+)/)
    if (sm) totalSilenceSec += parseFloat(sm[1])
  }
  ff.on('log', onLog)
  try {
    // `-f null -` discards output; we only care about stderr from
    // silencedetect. Suppress nonzero exits — silencedetect always
    // returns 0, but defensive in case the input has structural issues.
    await ff
      .exec([
        '-i', input,
        '-af', `silencedetect=noise=${SILENCE_THRESHOLD_DB}dB:d=${SILENCE_MIN_RUN_S}`,
        '-f', 'null', '-',
      ])
      .catch(() => {})
  } finally {
    ff.off('log', onLog)
  }
  if (!hasAudio || durationSec <= 0) return false
  return totalSilenceSec >= durationSec * SILENT_COVERAGE_RATIO
}

/**
 * Lossless container rewrite that moves the moov atom to the file start
 * (`-movflags +faststart`) so the browser can begin playback after a few
 * KB rather than probing the whole file for metadata. `-c copy` skips
 * any bitstream re-encode, so the operation completes in seconds and
 * quality is preserved exactly. Returns null on any failure so the
 * caller can fall back to uploading the source unchanged.
 *
 * Audio: a silencedetect probe runs first. Tracks that are dead-air
 * across their full duration get stripped with `-an`, shrinking the
 * file ~10–25% on the silent loops that dominate the Kismet catalog.
 * Threshold is strict so intentional audio is never lost; on probe
 * failure we keep audio.
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
    const stripAudio = await isAudioSilent(ff, inputName).catch(() => false)
    const args = ['-i', inputName, '-c', 'copy', '-movflags', '+faststart']
    if (stripAudio) args.push('-an')
    args.push(outputName)
    await ff.exec(args)
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
