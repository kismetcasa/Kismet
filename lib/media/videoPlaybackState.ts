/**
 * Per-tab playback resume state for video moments. Keyed by src so the same
 * moment resumes wherever it's next rendered with controls — typically the
 * detail page on revisit or after a back-button.
 *
 * Save/restore is gated on the rendered surface having native controls
 * (i.e. the user is actively engaged with the video, vs. card/modal
 * autoplay-loop previews that are decorative). Without that gate, the
 * resume point would thrash around random loop positions instead of
 * tracking real watch progress.
 *
 * State lives in module scope, which in Next.js App Router survives
 * client-side navigation within the same tab. Clears on hard refresh or
 * new tab — that's deliberate. Cross-session persistence would need
 * sessionStorage; not built yet, easy to add when we want it.
 */
type State = { currentTime: number }

const playbackState = new Map<string, State>()

// Below 1s is "video just mounted, hasn't really played" — saving that
// would clobber an existing N-second resume point with effectively zero.
const MIN_SAVEABLE_SECONDS = 1

export function saveVideoPlaybackState(src: string, video: HTMLVideoElement): void {
  if (!src) return
  const t = video.currentTime
  if (!Number.isFinite(t) || t < MIN_SAVEABLE_SECONDS) return
  playbackState.set(src, { currentTime: t })
}

export function loadVideoPlaybackState(src: string): State | undefined {
  return src ? playbackState.get(src) : undefined
}
