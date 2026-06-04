// Central coordinator for FEED (non-committed) inline video playback.
//
// Each mounted feed <video> registers here and reports its distance to the
// viewport centre (read straight off its IntersectionObserver entry — no
// main-thread layout). The coordinator ranks every registered video by that
// distance and hands back two booleans per video:
//
//   • play   — may actively decode + present. Capped at MAX_CONCURRENT_PLAY
//              (the iOS WebKit simultaneous-decoder budget) and suppressed
//              entirely while the user is actively scrolling or while a
//              committed/detail video owns the screen. The poster/thumbhash
//              layer carries the visual in the meantime, so the feed never
//              breaks on a fast flick — we simply don't spin up new decoders
//              mid-scroll, then start the nearest few the instant it settles.
//   • buffer — may warm its bytes + first frame ahead of time (preload=auto).
//              The BUFFER_AHEAD nearest videos are warmed — including ones
//              just off-screen — so the card you land on plays instantly
//              instead of spinning up cold.
//
// Crucially this only toggles play/pause/preload on elements the browser lays
// out in-flow. Nothing is positioned or transformed, so it cannot reintroduce
// the fixed-overlay "video parks over the wrong card / smears on momentum
// scroll" bug class that the inline-video migration removed — that was a
// *positioning* failure; this touches only *decode/buffer* state.
//
// MAX_CONCURRENT_PLAY and BUFFER_AHEAD are deliberately small and are the two
// knobs to tune on-device (the real iOS ceiling is empirical + device/version
// dependent and not officially published).

import { committedActive, onCommittedChange } from './videoFocus'

const MAX_CONCURRENT_PLAY = 3
const BUFFER_AHEAD = 5
// Quiet window after the last scroll tick before we treat the feed as settled
// and let the nearest videos start. `scrollend` isn't reliable across the iOS
// webview versions we target, so a short debounce is the portable signal.
const SETTLE_MS = 140

export interface FeedVideoSlot {
  /** May actively play (decode + present). */
  play: boolean
  /** May warm media ahead of time (preload=auto). */
  buffer: boolean
}

interface Reg {
  /** px from the element centre to the viewport centre; smaller = nearer. */
  distance: number
  intersecting: boolean
  notify: (slot: FeedVideoSlot) => void
  last: FeedVideoSlot
}

const regs = new Map<number, Reg>()
let nextId = 1
let scrolling = false
let rafQueued = false
let installed = false

/**
 * Register a feed video. `update` feeds the coordinator this card's latest
 * distance + on-screen state (call it from the card's IntersectionObserver);
 * `notify` is invoked whenever this card's grant changes. Call `release` on
 * unmount.
 */
export function registerFeedVideo(notify: (slot: FeedVideoSlot) => void): {
  update: (distance: number, intersecting: boolean) => void
  release: () => void
} {
  ensureInstalled()
  const id = nextId++
  regs.set(id, {
    distance: Number.POSITIVE_INFINITY,
    intersecting: false,
    notify,
    last: { play: false, buffer: false },
  })
  return {
    update(distance, intersecting) {
      const r = regs.get(id)
      if (!r || (r.distance === distance && r.intersecting === intersecting)) return
      r.distance = distance
      r.intersecting = intersecting
      schedule()
    },
    release() {
      regs.delete(id)
      schedule()
    },
  }
}

// Coalesce bursts of IO callbacks / scroll ticks into one recompute per frame.
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
    const canPlay =
      !scrolling && !committed && r.intersecting && playing < MAX_CONCURRENT_PLAY
    if (canPlay) playing++
    // A playing video is always also buffered; otherwise the BUFFER_AHEAD
    // nearest videos warm regardless of whether they're on screen yet, so
    // landing on the next row is instant.
    const buffer = canPlay || i < BUFFER_AHEAD
    if (canPlay !== r.last.play || buffer !== r.last.buffer) {
      r.last = { play: canPlay, buffer }
      r.notify(r.last)
    }
  }
}

function ensureInstalled(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  let settleTimer: ReturnType<typeof setTimeout> | undefined
  const settle = () => {
    if (!scrolling) return
    scrolling = false
    schedule()
  }
  const onScroll = () => {
    if (!scrolling) {
      scrolling = true
      schedule()
    }
    clearTimeout(settleTimer)
    settleTimer = setTimeout(settle, SETTLE_MS)
  }
  // Passive + capture so we observe the document scroll and any nested
  // scroller without ever blocking the scroll itself.
  window.addEventListener('scroll', onScroll, { passive: true, capture: true })
  // A detail/lightbox video opening or closing changes who may play.
  onCommittedChange(schedule)
}
