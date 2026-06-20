// Shared one-shot recovery for stale-deploy chunk errors.
//
// Self-hosted single-container deploys (output: 'standalone', no CDN/asset
// retention yet) bake one build's hashed chunks per image. When a new image
// rolls out, the old chunk URLs 404 from the new container — any client that
// kept an old page open hits ChunkLoadError on its next lazy import(). The
// only recovery is a reload to fetch the fresh asset manifest.
//
// Guard is time-based, NOT a permanent flag: a chunk that still 404s right
// after a reload (genuine missing-asset bug) can't spin a tight loop, yet a
// SECOND deploy later in the same session can still self-heal. Shared by the
// render-boundary (app/error.tsx) and the event-handler path (lib/toast.ts)
// so the two never double-reload.
const GUARD_KEY = 'chunk-reloaded-at'
const GUARD_WINDOW_MS = 30_000

// In-flight irreversible operations (a mint, a collection deploy) during which
// a destructive auto-reload must NOT fire. A media mint streams its bytes
// straight to Turbo (credits already spent) while the large upload saturates
// the client uplink — that stalls background route-prefetch chunk downloads,
// which webpack surfaces as a ChunkLoadError indistinguishable from a stale
// deploy. Without this guard the self-heal reloads mid-mint, aborting the
// (paid) upload and dropping the user onto a fresh load the saturated
// connection can't serve. A depth counter, not a boolean, so overlapping ops
// compose and one stray end() can't prematurely re-enable reloads.
let criticalOpDepth = 0

/** Mark the start of an irreversible op; pair with endCriticalOp() in finally. */
export function beginCriticalOp(): void {
  criticalOpDepth += 1
}

/** Mark the end of an irreversible op. Clamped at 0 so an unbalanced call can't
 *  drive it negative and permanently suppress stale-deploy recovery. */
export function endCriticalOp(): void {
  criticalOpDepth = Math.max(0, criticalOpDepth - 1)
}

/**
 * Reload once to recover from a stale-deploy chunk error, unless we already
 * reloaded within the guard window. Returns true if a reload was triggered
 * (caller should stop — the page is going away), false if suppressed (caller
 * should fall back to a manual "reload" affordance).
 *
 * `delayMs` lets a caller paint an explanatory toast before the reload fires.
 */
export function reloadOnceForChunkError(delayMs = 0): boolean {
  if (typeof window === 'undefined') return false
  // Never auto-reload while an irreversible op is in flight — a transient chunk
  // timeout during a mint/deploy would otherwise abort paid work. The caller
  // (toastError) falls back to a manual "Reload" affordance instead.
  if (criticalOpDepth > 0) return false
  let last = 0
  try {
    last = Number(sessionStorage.getItem(GUARD_KEY) || 0)
  } catch {
    // sessionStorage can throw in private-mode / sandboxed webviews. Treat as
    // "never reloaded" so recovery still fires; the worst case is one extra
    // reload, never a loop (the immediate re-error path returns here again).
  }
  if (last && Date.now() - last < GUARD_WINDOW_MS) return false
  try {
    sessionStorage.setItem(GUARD_KEY, String(Date.now()))
  } catch {
    // Ignore — proceed with the reload regardless.
  }
  if (delayMs > 0) {
    setTimeout(() => window.location.reload(), delayMs)
  } else {
    window.location.reload()
  }
  return true
}
