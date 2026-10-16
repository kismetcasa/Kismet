'use client'

import { useCallback, useEffect, useRef } from 'react'

/**
 * Where a reader is in a zine, and how the reader sits in the browser's
 * history — shared by the public entry (components/MomentZine) and the
 * collectors-only one (components/CollectorFileViewer).
 *
 * THE BACK GESTURE CLOSES THE READER. On a phone the reader fills the
 * screen, and the edge swipe (iOS), the back button (Android) and a Mini App
 * host's own back control all mean "get me out of this" — without a history
 * entry of its own, every one of them would leave the ARTWORK instead. So
 * opening pushes one entry marked as ours; back pops it and the popstate
 * closes the reader; closing from the UI goes through history.back() so the
 * stack never keeps a dead entry. Next's App Router patches pushState and
 * replaceState to carry its own state along, and restores the same page on
 * the pop, so this composes with client navigation.
 */

const RESUME_PREFIX = 'kismet:zine-page:'
const READER_STATE_KEY = 'kismetZineReader'

/** The page to open on: a shared `?page=N` wins, then the remembered spot. */
export function readStartPage(storageKey: string, opts: { url?: boolean } = {}): number | undefined {
  try {
    // `?page=` addresses the artwork's own zine; a collector file read from
    // the same page passes url: false so a shared link never opens it there.
    const fromUrl = opts.url === false ? NaN : Number(new URL(window.location.href).searchParams.get('page'))
    if (Number.isInteger(fromUrl) && fromUrl > 0) return fromUrl
    const stored = Number(window.localStorage.getItem(RESUME_PREFIX + storageKey))
    if (Number.isInteger(stored) && stored > 1) return stored
  } catch {
    /* private mode, blocked storage: start at the cover */
  }
  return undefined
}

/** The URL follows the page a reader settles on, this long after the last
 *  turn. A scrubber drag changes the page on every input event, and WebKit
 *  throws once replaceState runs ~100 times in 10 s (Chrome starts dropping
 *  calls at 200) — a drag across a long zine would leave the URL behind. */
const URL_SETTLE_MS = 300
let urlWrite: ReturnType<typeof setTimeout> | undefined

/** Remember the page (resume) at once and, unless `url: false`, reflect it
 *  in the URL (shareable) once the reader settles. `url: false` is the
 *  collector-file reader: `?page=` addresses the artwork's own zine. */
export function rememberPage(storageKey: string, page: number, opts: { url?: boolean } = {}): void {
  try {
    window.localStorage.setItem(RESUME_PREFIX + storageKey, String(page))
  } catch {
    /* private mode, blocked storage: no resume */
  }
  if (opts.url === false) return
  clearTimeout(urlWrite)
  urlWrite = setTimeout(() => {
    // Only onto a reader's own entry: a write landing after the reader
    // closed would put the page on the artwork's entry.
    if (readerEntryToken() === null) return
    try {
      const url = new URL(window.location.href)
      if (page > 1) url.searchParams.set('page', String(page))
      else url.searchParams.delete('page')
      // Spread the current state: Next's internals and our reader marker
      // both live there and must survive the replace.
      window.history.replaceState({ ...(window.history.state ?? {}) }, '', url.toString())
    } catch {
      /* best effort */
    }
  }, URL_SETTLE_MS)
}

const ROTATE_PREFIX = 'kismet:zine-rotate:'

/** A remembered extra rotation for a zine (a landscape scan read upright on
 *  a phone), 0 / 90 / 180 / 270. */
export function readRotation(storageKey: string): number {
  try {
    const stored = Number(window.localStorage.getItem(ROTATE_PREFIX + storageKey))
    return [90, 180, 270].includes(stored) ? stored : 0
  } catch {
    return 0
  }
}

export function rememberRotation(storageKey: string, rotation: number): void {
  try {
    if (rotation % 360 === 0) window.localStorage.removeItem(ROTATE_PREFIX + storageKey)
    else window.localStorage.setItem(ROTATE_PREFIX + storageKey, String(rotation % 360))
  } catch {
    /* best effort */
  }
}

/** The token of the entry on top, if it is a reader entry of this page. */
function readerEntryToken(): number | null {
  const v = (window.history.state as Record<string, unknown> | null)?.[READER_STATE_KEY]
  return typeof v === 'number' ? v : null
}
let nextToken = 0

/**
 * Back-gesture-aware open/close. While `open`, one history entry marked as
 * ours sits on top; a pop past it calls `onBackClose`. The returned function
 * is the UI's close: it pops our entry (so the popstate closes the reader),
 * or closes directly when no entry could be pushed.
 */
export function useReaderHistory(open: boolean, onBackClose: () => void): () => void {
  const onBackRef = useRef(onBackClose)
  onBackRef.current = onBackClose
  const pushedRef = useRef(false)
  // One token per open, so an entry left by an EARLIER open (reachable again
  // through the browser's forward button) is never mistaken for this one —
  // a boolean marker made the close need two presses in that sequence.
  const tokenRef = useRef(0)

  useEffect(() => {
    if (!open) return
    const token = ++nextToken
    tokenRef.current = token
    try {
      window.history.pushState({ ...(window.history.state ?? {}), [READER_STATE_KEY]: token }, '', window.location.href)
      pushedRef.current = true
    } catch {
      pushedRef.current = false
    }
    const onPop = () => {
      // Still on this open's entry: nothing to do.
      if (readerEntryToken() === token) return
      pushedRef.current = false
      onBackRef.current()
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      // Closed by other means while our entry is still on top (an unmount,
      // a navigation): strip the marker so a later back lands on a plain
      // artwork page rather than a reader that no longer exists.
      if (pushedRef.current && readerEntryToken() === token) {
        pushedRef.current = false
        try {
          const s = { ...(window.history.state as Record<string, unknown>) }
          delete s[READER_STATE_KEY]
          window.history.replaceState(s, '', window.location.href)
        } catch {
          /* best effort */
        }
      }
    }
  }, [open])

  return useCallback(() => {
    if (pushedRef.current && readerEntryToken() === tokenRef.current) {
      // Once only: a second close before the pop lands (two layers closing
      // in the same tick) must not go back again — that would leave the
      // artwork page itself. It exits directly instead.
      pushedRef.current = false
      window.history.back()
      return
    }
    onBackRef.current()
  }, [])
}
