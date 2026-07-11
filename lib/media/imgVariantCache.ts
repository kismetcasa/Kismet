// Persistent disk cache + request coalescing for /api/img's ?w= resize
// variants — the storage half of the route's optimizer-fallback path.
//
// WHY THIS EXISTS: sources past the next/image optimizer's body cap
// (images.maximumResponseBody — 50MB default, and the optimizer streams the
// full cap from the gateway before rejecting) 413 the optimizer and land on
// /api/img?w=, which used to re-download the FULL multi-MB source from the
// gateway and re-run the sharp resize on EVERY request — the only caches
// were the viewer's browser and an optional CDN that isn't in front today.
// The featured Patron mint pass (a physical-artwork scan, the live instance
// of the class) paid a 2-3s first paint per viewer while every optimizer-
// eligible card beside it served from next/image's on-disk cache in
// milliseconds. These helpers give the over-cap class the same economics:
// compute a variant once, serve it from local disk forever
// (content-addressed source ⇒ the variant never goes stale).
//
// Disk, not Redis: Upstash REST is base64-framed and billed per byte — the
// wrong medium for media buffers. `.next/cache` is the Coolify-mounted
// volume that already persists Next's own optimizer cache across deploys
// (Dockerfile pre-creates it nextjs-owned), so variants survive restarts AND
// deploys with zero new infra. Like the optimizer cache it is per-pod local
// disk (SCALING_AUDIT §5): a CDN stays the multi-pod/edge answer — this
// makes the origin's share of a miss cheap, wherever the edge sits.
//
// Kept outside the route file (Next route modules may only export handlers)
// so scripts/verify-img-cache.ts can exercise the key math, the atomic
// write/read round trip, eviction ordering, and the single-flight semantics
// against a temp directory.

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Production cache directory — inside the persisted `.next/cache` volume. */
export const VARIANT_CACHE_DIR = join(process.cwd(), '.next', 'cache', 'kismet-img')

// Disk budget for the variant set. Variants are small (a 2048px WebP of even
// a huge scan lands well under ~1MB) so this holds thousands of assets;
// alongside the optimizer cache's 5GB cap (next.config.mjs) it keeps total
// image-cache disk bounded on the 200GB host. Past the cap, the sweep below
// LRU-evicts by mtime — recompute cost for an evicted variant is one more
// cold fetch+resize, exactly the pre-cache behavior.
export const VARIANT_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024
// Sweep down to 90% of cap so each sweep buys headroom instead of running
// again on the very next write.
const EVICT_TARGET_RATIO = 0.9
// A .tmp file only outlives its atomic rename if the process died mid-write;
// anything this old is a stray, not an in-flight write.
const TMP_STALE_MS = 60 * 60 * 1000

// Requested widths snap UP to a bucket. The real producer (MomentImage's
// optimizer→proxy fallback) only ever sends 2048, which maps to itself — the
// buckets exist so an arbitrary ?w= can't mint an unbounded variant set per
// asset (4096 distinct files) and so any future variable-width caller shares
// cache entries instead of fragmenting them. Snapping up only means less
// downscaling; every render context object-fits the result anyway.
const WIDTH_BUCKETS = [256, 512, 1024, 2048, 4096] as const

export function bucketWidth(w: number): number {
  for (const b of WIDTH_BUCKETS) if (w <= b) return b
  return WIDTH_BUCKETS[WIDTH_BUCKETS.length - 1]
}

/**
 * Cache file name for a (source URI, bucketed width) pair. The URI is hashed
 * (it contains `://` and arbitrary characters) so the name is always a safe
 * flat path; the `v1-` prefix versions the OUTPUT parameters (webp q80,
 * fit-inside) — bump it if those change and the stale generation simply ages
 * out via the sweep instead of being served.
 */
export function variantFileName(u: string, width: number): string {
  return `v1-${createHash('sha256').update(u).digest('hex')}-w${width}.webp`
}

/**
 * Read a cached variant. A hit refreshes the file's timestamps so the
 * eviction sweep's oldest-mtime ordering approximates LRU (relatime mounts
 * don't reliably bump atime on read). Any error — missing file, missing
 * directory, permission — is a miss; the caller recomputes.
 */
export async function readVariant(dir: string, name: string): Promise<Buffer | null> {
  try {
    const file = join(dir, name)
    const buf = await readFile(file)
    const now = new Date()
    void utimes(file, now, now).catch(() => {})
    return buf
  } catch {
    return null
  }
}

/**
 * Persist a variant atomically (tmp + rename, so concurrent writers of the
 * same key can't interleave and readers never observe a partial file), then
 * sweep if the directory is over budget. Best-effort throughout: cache-write
 * failure must never fail the response that computed the variant.
 */
export async function writeVariant(dir: string, name: string, buf: Buffer): Promise<void> {
  try {
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, `${name}.${randomUUID()}.tmp`)
    await writeFile(tmp, buf)
    await rename(tmp, join(dir, name))
  } catch {
    return
  }
  await evictOverCap(dir, VARIANT_CACHE_MAX_BYTES)
}

// One sweep at a time — writes are rare (once per new variant, ever) but a
// burst of first-time computes shouldn't stack N directory scans.
let sweeping = false

/**
 * Bound the cache directory: when total variant bytes exceed `capBytes`,
 * delete oldest-mtime files (mtime is refreshed on every read, so this is
 * LRU) until under EVICT_TARGET_RATIO × cap. Also reaps stale .tmp strays
 * from crashed mid-writes. Best-effort; failures leave the cache oversized
 * until the next write retries the sweep.
 */
export async function evictOverCap(dir: string, capBytes: number): Promise<void> {
  if (sweeping) return
  sweeping = true
  try {
    const names = await readdir(dir)
    const entries: { name: string; size: number; mtimeMs: number }[] = []
    let total = 0
    const now = Date.now()
    for (const name of names) {
      const st = await stat(join(dir, name)).catch(() => null)
      if (!st?.isFile()) continue
      if (name.endsWith('.tmp')) {
        if (now - st.mtimeMs > TMP_STALE_MS) void rm(join(dir, name), { force: true }).catch(() => {})
        continue
      }
      entries.push({ name, size: st.size, mtimeMs: st.mtimeMs })
      total += st.size
    }
    if (total <= capBytes) return
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
    const target = capBytes * EVICT_TARGET_RATIO
    for (const e of entries) {
      if (total <= target) break
      await rm(join(dir, e.name), { force: true }).catch(() => {})
      total -= e.size
    }
  } catch {
    // readdir failed (dir missing, permissions) — nothing to bound.
  } finally {
    sweeping = false
  }
}

/**
 * Single-flight coalescer: concurrent callers with the same key share ONE
 * compute — its result (or rejection) fans out to every waiter, and the slot
 * clears on settle so the next request after a failure retries fresh.
 *
 * For /api/img this is drop-time armor: N viewers landing on a cold featured
 * asset used to trigger N full source downloads + N sharp jobs; now the
 * first request computes while the rest await the same promise.
 */
export class SingleFlight<T> {
  private inflight = new Map<string, Promise<T>>()

  run(key: string, compute: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key)
    if (existing) return existing
    const p = (async () => compute())().finally(() => {
      this.inflight.delete(key)
    })
    this.inflight.set(key, p)
    return p
  }

  /** Observability/test hook — number of computes currently in flight. */
  get size(): number {
    return this.inflight.size
  }
}
