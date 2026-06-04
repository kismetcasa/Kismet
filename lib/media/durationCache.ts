// Client-side memo of video durations keyed by the RAW media URI
// (ar://|ipfs://|https://) — the exact string InlineVideo reads back with
// (getVideoDuration(src), where src is resolveMomentMedia's media.src).
// Populated by MomentCard from each Moment's server-stitched
// kismet_duration_sec field (KV-stitched onto the /api/timeline response).
// Read by InlineVideo to pick the long-form preload strategy at
// element-create time, skipping the round trip to `loadedmetadata`.
//
// LRU-bounded (not a bare Map) so a long browse session over a large video
// catalog can't grow it without bound — matches the other browser-side
// caches (momentCache, textCache, profileCache, …). Entries are tiny
// (string → int) so the cap is generous; it exists purely as a ceiling.

import { LRUCache } from '@/lib/lruCache'

const cache = new LRUCache<string, number>(512)

export function setVideoDuration(src: string, durationSec: number): void {
  if (!src || !Number.isFinite(durationSec) || durationSec <= 0) return
  cache.set(src, Math.round(durationSec))
}

export function getVideoDuration(src: string): number | undefined {
  return cache.get(src)
}
