// Client-side memo of video durations keyed by canonical src URL.
// Populated by PaginatedGrid as soon as /api/timeline responses arrive
// (the route surfaces durationSec via the KV stitch onto each Moment's
// kismet_duration_sec field). Read by SharedVideoProvider.createVideo to
// pick the long-form preload strategy at element-create time, skipping
// the round trip to `loadedmetadata` that otherwise drives the
// short→long tier upgrade.
//
// Module-level so it survives unmounts within a session — the same
// video re-mounted on a different feed reuses the seeded value.
// Cleared automatically when the tab unloads; no LRU needed at typical
// catalog sizes.

const cache = new Map<string, number>()

export function setVideoDuration(src: string, durationSec: number): void {
  if (!src || !Number.isFinite(durationSec) || durationSec <= 0) return
  cache.set(src, Math.round(durationSec))
}

export function getVideoDuration(src: string): number | undefined {
  return cache.get(src)
}
