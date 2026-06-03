// Cross-surface inline-video coordination. The old shared pool moved a single
// <video> element from card to detail (the morph) so only one decoder was ever
// live for a given moment. With inline videos each surface owns its own
// element, so when the detail's committed player opens we instead PAUSE the
// feed-card videos behind it: they sit under the detail overlay where playing
// them only wastes decoders and competes for iOS's small decode budget — the
// budget the detail the user is actually watching needs.
//
// "Committed" = a detail/lightbox video with native controls. While at least
// one is mounted, feed cards stay paused; they resume when it closes.

let committedCount = 0
const listeners = new Set<() => void>()

export function committedActive(): boolean {
  return committedCount > 0
}

/** Register a committed (controls) video. Returns a release fn for unmount. */
export function acquireCommitted(): () => void {
  committedCount += 1
  for (const l of listeners) l()
  let released = false
  return () => {
    if (released) return
    released = true
    committedCount -= 1
    for (const l of listeners) l()
  }
}

/** Subscribe to committed-state changes (feed cards re-evaluate play/pause). */
export function onCommittedChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
