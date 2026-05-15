/**
 * Cross-mount playback resume for video moments. Keyed by src so the same
 * moment resumes wherever it's next rendered — card autoplay-loop position
 * carries into the detail page; detail page position survives a refresh.
 *
 * Backed by sessionStorage so state persists across hard refreshes within
 * the same tab. New tabs start fresh (sessionStorage is per-tab). The
 * module-level Map is a hot cache on top — avoids hitting sessionStorage
 * for every timeupdate tick.
 */
type State = { currentTime: number }

const STORAGE_KEY = 'kismet:videoPlaybackState'

const playbackState = new Map<string, State>()

// Hydrate the in-memory Map from sessionStorage on first import (browser
// only). Wrapped in try/catch since sessionStorage can throw in private
// browsing modes and the JSON could be corrupt if something else wrote
// to the key.
if (typeof window !== 'undefined') {
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored) as Record<string, State>
      for (const [src, state] of Object.entries(parsed)) {
        if (state && Number.isFinite(state.currentTime)) {
          playbackState.set(src, state)
        }
      }
    }
  } catch {
    // ignore — state just won't carry across refreshes for this user
  }
}

function persist(): void {
  if (typeof window === 'undefined') return
  try {
    const obj: Record<string, State> = {}
    playbackState.forEach((state, src) => { obj[src] = state })
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(obj))
  } catch {
    // ignore — quota exceeded / private browsing
  }
}

export function saveVideoPlaybackState(src: string, video: HTMLVideoElement): void {
  if (!src) return
  const t = video.currentTime
  if (!Number.isFinite(t) || t < 0) return
  // Don't clobber an active-watch position (>1s, looks like real
  // engagement) with a near-zero from an autoplay-loop wraparound or a
  // brief mount-then-unmount. But do save small positive values when
  // there's no existing meaningful save — that's how short looping
  // videos (~2-3s) get any resume point at all.
  const existing = playbackState.get(src)
  if (existing && existing.currentTime > 1 && t < 0.25) return
  playbackState.set(src, { currentTime: t })
  persist()
}

export function loadVideoPlaybackState(src: string): State | undefined {
  return src ? playbackState.get(src) : undefined
}

