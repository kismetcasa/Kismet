// Central coordinator for FEED (non-committed) inline video playback.
//
// Each mounted feed <video> registers here and reports, from its
// IntersectionObserver, its distance to the viewport centre and whether it is
// actually on screen. The coordinator ranks every registered video by that
// distance and hands back two booleans per video:
//
//   • play   — the nearest ON-SCREEN videos play, capped at MAX_CONCURRENT_PLAY
//              (constrained: mobile + embedded iframe). Distance ranking
//              makes this centre-biased — on a 2-col grid the centre row plays.
//              Videos keep playing THROUGH a scroll and pause only when they
//              leave the viewport: there is no blanket "pause during scroll",
//              so the feed stays lively and a video is already playing when you
//              land on it (Goal 3), while the cap bounds the iOS budget (Goal 2).
//   • buffer — the BUFFER_AHEAD nearest videos warm their bytes + first frame
//              (preload=auto), including ones just off-screen, so a video plays
//              the instant it enters view.
//
// Play gates on TRUE-viewport overlap (computed by InlineVideo from the entry
// rect), not the wide buffer rootMargin — so a just-off-screen card can be
// warmed but never wins a decode slot.
//
// Nothing here moves an element — only play/pause/preload toggle — so it can't
// reintroduce the fixed-overlay positioning bug the inline migration removed.
//
// Deliberately NO per-video play-dwell and NO scroll-gate: a fast flick can
// briefly cycle the capped (≤3) set of decoders. If on-device testing shows
// that churn stutters, the cheapest fix is a short per-video play-dwell (start
// a video only after it's been a play candidate for ~120ms) — strictly better
// than a global scroll-gate because it never pauses an already-playing video.
// Add it only if measured to be needed.

import { committedActive, onCommittedChange } from './videoFocus'
import { isMobileDevice } from '../deviceUA'
import { isInIframe } from './gateway'

// The mobile/web split for video, capped on the two surfaces that are
// resource-constrained for <video>:
//   • mobile — iOS WebKit's small simultaneous-decoder budget + tighter memory.
//   • iframe — a Mini App on Farcaster desktop runs embedded, sharing the host
//     page's HTTP/2 pool; uncapped video floods it on cold load and starves the
//     SDK chunk + ready() handshake, pinning the host splash.
// STANDALONE desktop has neither limit, so Infinity disables BOTH the play cap
// AND the decoder release (a video releases only once it leaves the buffer
// window, impossible when the window is unbounded) — it plays every visible
// video and keeps them warm. Read once at module load on the client; the
// coordinator is client-only (see ensureInstalled), so the server value is
// never used.
const CONSTRAINED = isMobileDevice() || isInIframe()
const MAX_CONCURRENT_PLAY = CONSTRAINED ? 3 : Infinity
const BUFFER_AHEAD = CONSTRAINED ? 5 : Infinity

export interface FeedVideoSlot {
  /** May actively play (decode + present). */
  play: boolean
  /** May warm media ahead of time (preload=auto). */
  buffer: boolean
}

interface Reg {
  /** px from the element centre to the viewport centre; smaller = nearer. */
  distance: number
  /** Actually overlapping the true viewport (a play candidate). */
  visible: boolean
  notify: (slot: FeedVideoSlot) => void
  last: FeedVideoSlot
}

const regs = new Map<number, Reg>()
let nextId = 1
let rafQueued = false
let installed = false

/**
 * Register a feed video. `update` feeds the coordinator this card's latest
 * distance + on-screen state (call it from the card's IntersectionObserver);
 * `notify` is invoked whenever this card's grant changes. Call `release` on
 * unmount.
 */
export function registerFeedVideo(notify: (slot: FeedVideoSlot) => void): {
  update: (distance: number, visible: boolean) => void
  release: () => void
} {
  ensureInstalled()
  const id = nextId++
  regs.set(id, {
    distance: Number.POSITIVE_INFINITY,
    visible: false,
    notify,
    last: { play: false, buffer: false },
  })
  return {
    update(distance, visible) {
      const r = regs.get(id)
      if (!r || (r.distance === distance && r.visible === visible)) return
      r.distance = distance
      r.visible = visible
      schedule()
    },
    release() {
      regs.delete(id)
      schedule()
    },
  }
}

// Coalesce bursts of IO callbacks into one recompute per frame.
function schedule(): void {
  if (rafQueued || typeof window === 'undefined') return
  rafQueued = true
  window.requestAnimationFrame(() => {
    rafQueued = false
    recompute()
  })
}

function recompute(): void {
  const ranked = [...regs.values()].sort((a, b) => a.distance - b.distance)
  const committed = committedActive()
  let playing = 0
  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i]
    // The nearest on-screen videos play, capped — centre-biased by the ranking.
    // No scroll-gate: a visible video keeps playing through a scroll.
    const canPlay = !committed && r.visible && playing < MAX_CONCURRENT_PLAY
    if (canPlay) playing++
    // The nearest BUFFER_AHEAD videos stay in the "loaded" window; everything
    // else is released by InlineVideo to free the iOS media-element budget
    // (pausing alone does NOT free a decoder). When a committed/detail video is
    // open the feed is hidden behind it, so drop the whole feed out of the
    // window — releasing its decoders so the detail's fresh element loads now.
    const buffer = !committed && (canPlay || i < BUFFER_AHEAD)
    if (canPlay !== r.last.play || buffer !== r.last.buffer) {
      r.last = { play: canPlay, buffer }
      r.notify(r.last)
    }
  }
}

function ensureInstalled(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  // A detail/lightbox video opening or closing changes who may play.
  onCommittedChange(schedule)
}
