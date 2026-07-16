# Kismet — Ops Runbook (single-container uptime + CDN)

_Operating the one container: why it went down ("bad gateway" / "no server
available"), the in-repo fixes that landed, the Coolify changes you must make, and
the CDN configuration that offloads `/api/img`. Companion to `SCALING.md` (scale
cliffs + remediation) and `STACK_OVERVIEW.md` (the full component map). This file is
about **acute uptime + edge offload of the one box**, not architectural scale._

## TL;DR — what the two errors mean here

We run **one** Docker container on **one** Oracle Ampere host via Coolify (Traefik
proxy). With a single instance there is zero redundancy, so:

- **"bad gateway (502)"** = the lone `node server.js` died mid-request (V8 heap OOM /
  crash), so Traefik got a closed connection.
- **"no server available"** = Traefik has **zero healthy backends** — the one pod is
  down/restarting or was evicted by a failing health check.

Both collapse to the same root: **the one process dies or gets pulled, and there is no
peer to absorb it.** The fix set is two-pronged — *stop the deaths/evictions* (in-repo,
shipped) **and** *survive + recover fast* (ops, below).

---

## 1. Root cause + the fixes that landed

**⭐ THE crash: V8 JavaScript-heap OOM at ~2 GB, every ~45 min.** The container logs
caught `FATAL ERROR: Ineffective mark-compacts near heap limit — JavaScript heap out of
memory` at ~2030 MB, with the timeline `airdroppable` fan-out logged immediately before
each death. This was a **V8 heap OOM, not a kernel/cgroup OOM** — hence `OOMKilled=false`,
clean `dmesg`, and cgroup `oom_kill=0` (all of which masked it). Two compounding causes:

1. **No cgroup memory limit** (`memory.max = max`) ⇒ Node 22 fell back to V8's **~2 GB
   default heap** while the **11 GB host sat ~9 GB idle** — it died with most of the box free.
2. **The timeline fan-out merge** grew the heap unbounded over ~45 min until it hit 2 GB.

Each crash + slow restart = one "no server available" / "bad gateway" window. Everything
below is either the code that stopped the deaths or the ops config that makes recovery
instant.

### Confirmed causes → in-repo fixes (adversarially verified against the code)

| # | Cause | Error | Fix (shipped) |
|---|-------|-------|---------------|
| 1 | **V8 heap OOM at ~2 GB** (above) | both | `Dockerfile` sets `NODE_OPTIONS=--max-old-space-size=4096`; timeline `MERGE_BUDGET` bounds the growth |
| 3 | **Timeline fan-out** held `collections × up-to-10,000` moments in heap to render 20 | 502 (OOM) | `MERGE_BUDGET` (5k/10k) distributed across the fan-out caps peak heap + MGET stitch + sort |
| 5 | **Fan-out fetches lacked timeouts + concurrency cap** → slow inprocess piles up handlers/sockets | both | `AbortSignal.timeout(8s)` per fetch + `FANOUT_CONCURRENCY=10` |
| 6 | **Auto-pipelining co-batched the readiness ping** behind a fat payload → false-slow → false 503 | no server available | dedicated non-pipelined probe client |
| 2 | **Readiness hard-gated on one 3s Upstash ping** (dormant — Coolify gates on `/api/health`) | no server available | consecutive-failure tolerance (`READINESS_FAILURE_THRESHOLD=3`) |
| 9 | **Blocking cold start** — `register()` awaited an RPC healthcheck + unbounded `SMEMBERS` warmup before serving | no server available | `instrumentation.ts` runs healthcheck/warmup/backfill fire-and-forget; drops the `SMEMBERS` warmup |
| 7 | **`/api/transcode-gif` buffers up to 300 MB** + ffmpeg + sharp | 502 (OOM) | bounded by `MAX_CONCURRENT=1` + the ops memory limit; streaming refactor is the follow-up |
| 4 | **`/api/img` unbounded streaming concurrency**, no CDN | 502 (aggregate RSS) | **Ops — CDN (§3 below)** |

**Refuted — do not chase:** unbounded `SMEMBERS` as an *OOM* (it hard-fails at Upstash's
10 MB cap → a 500, not a SIGKILL); an event-loop-wedge cascade (measured well under the
probe budget); `after()`-callback crashes (all wrapped); `maxDuration` as a real handler
timeout (a Vercel no-op on self-hosted `node server.js`); **"no process-level crash
handlers"** — Next 15's production server already installs `uncaughtException` /
`unhandledRejection` handlers that **log and keep the process alive**. Adding our own
`uncaughtException → process.exit(1)` would have *overridden* that and crashed the single
container Next intended to keep serving — a regression caught in review and removed. Crash
survival is the framework's job here.

### Files changed (in-repo)
- **`instrumentation.ts`** — de-blocks cold start (fire-and-forget healthcheck / warmup /
  backfill so `register()` returns instantly; Next awaits it before listening, so anything
  awaited there widens every restart's dark window). Crash survival left to Next 15.
- **`app/api/readiness/route.ts`** — dedicated **non-pipelined** probe client + 3-in-a-row
  failure tolerance (a single blip can't evict the only pod; a sustained outage still trips it).
- **`app/api/timeline/route.ts`** — `MERGE_BUDGET` bounds moments pulled into the merge;
  `AbortSignal.timeout(8s)` per fetch; fan-out capped to 10 concurrent.
- **`lib/coverMomentSynthesis.ts`** — `AbortSignal.timeout(8s)` on its two inprocess fetches.
- **`Dockerfile`** — `NODE_OPTIONS=--max-old-space-size=4096` in the runner stage.

### Production telemetry that confirmed the model
- Cold-start blocking was real: the first `/api/health` on a fresh container **timed out
  (>5 s)**, then passed in ~0.15 s once warm — the signature of `register()` blocking on
  its awaited RPC + cross-region Redis warmup.
- Deploys are clean: Coolify health-gates the rolling update on `/api/health` (new
  container must pass before the old is removed), so "no server available" is **not** a
  deploy artifact — it's the lone process being *down*.
- Redis cost is **GET-dominated** (session validation + unread-count poll dwarf all other
  commands); Redis lives in AWS `us-east-1` while the app runs on Oracle. **Measured
  2026-07-13 from inside the app container: ~4.4ms steady-state RTT (162ms cold
  first-connection)** — same-metro adjacency, so co-locating Redis was evaluated and
  **shelved** (`REDIS_IMPLEMENTATION_REVIEW.md` §5.1); the cold number is what amplified
  the cold-start block, and boot warmup already pre-warms the pool.

---

## 2. Ops changes you MUST make in Coolify (load-bearing — not in the repo)

On a single instance these are the difference between "recovers in seconds" and "dark
until someone notices." **Do once, then verify after the next deploy.**

1. **Heap ceiling + container memory limit (the limit does NOT replace the flag).**
   - Env var (fastest, no rebuild): **Environment Variables → `NODE_OPTIONS=--max-old-space-size=4096`**
     (Runtime ON) — applies on restart and overrides the image default.
   - **Also set Application → Advanced → Memory Limit `6g`** (Reservation `4g`) — not
     because Node derives a good heap from it (auto-derived defaults are undocumented,
     version-dependent, and can come out ~2 GB — reintroducing the crash) but because it
     (a) protects the host from a runaway container and (b) turns a silent breach into an
     attributable `OOMKilled=true` / exit 137 event. Keep the flag ≈ ⅔–¾ of the limit
     (4096 with 6g) so off-heap (undici, sharp, ffmpeg, `/api/img`) fits underneath.
   - Swap is likely unavailable on this kernel (deploy log: *"memory swappiness discarded /
     cgroup not mounted"*) — don't rely on paging; the heap cap + in-code bounds prevent the OOM.
2. **Restart policy: nothing to configure** — Coolify hardcodes `unless-stopped`
   (`RESTART_MODE` in `bootstrap/helpers/constants.php`; no per-app UI knob). A V8 FATAL
   aborts the process (exit 134), which `unless-stopped` restarts in seconds, so the
   recurring symptom is the crash+cold-start window, not a stays-dark outage. **Caveat:**
   restart policies act on process EXIT only — a hung-but-alive process isn't restarted by
   Docker (the Dockerfile HEALTHCHECK marks it unhealthy, Traefik stops routing; recovery
   from a true wedge is manual/Coolify-level).
3. **Readiness probe is DORMANT — `/api/health` is the gate.** Coolify health-gates the
   rolling update on the Dockerfile `HEALTHCHECK` (`/api/health`, always-200), not
   `/api/readiness`. For a single instance that's *correct* (never evict your only pod for
   a dependency blip), so the readiness hardening is harmless future-proofing. Only wire
   `/api/readiness` (with `failureThreshold` **3–5**) if/when you run ≥2 replicas.
4. **Put a CDN in front of `/api/img` + static (§3)** — the highest-leverage durable fix
   for the `/api/img` streaming vector (OWASP API4:2023 — bound origin/paid consumption).

### Verify (post-deploy)
```sh
docker inspect <c> --format '{{.HostConfig.Memory}}'                # 6442450944 (0 = none)
docker inspect <c> --format '{{.HostConfig.RestartPolicy.Name}}'    # unless-stopped
docker logs <c> | grep '\[mem\] boot'                              # heapLimitMb ≈ 4144 when the flag is live
docker inspect <c> --format 'exit={{.State.ExitCode}} OOMKilled={{.State.OOMKilled}}'  # after any incident
#   exit 134 / OOMKilled=false → V8 heap OOM (JS-heap growth — check [mem] heapUsedMb trend)
#   exit 137 / OOMKilled=true  → container limit breached (off-heap — check externalMb/arrayBuffersMb)
```
Also sanity-check the Redis-side caps: `SCARD kismetart:collections` (>250 = timeline
fan-out is thinning, expected + logged); `SCARD kismetart:created-mints` (growth
telemetry only since 2026-07-13 — reads are bounded `SMISMEMBER`, no full-set read
remains); `ZCARD kismetart:featured` should stay far below `MAX_FEATURED=1000`; watch
logs for `[notifications] large fan-out` (≥1k followers → start SCALING.md B2).

---

## 3. CDN — fronting `/api/img` (+ cacheable GETs)

The single highest-leverage infra change (`SCALING.md §B5` holds the verdict; this is the
how). `/api/img` streams up to 2 GB of immutable, content-addressed media through the one
Oracle box on every view (`app/api/img/route.ts`, `MAX_DECLARED_BYTES` at line 25). A CDN
turns repeat/popular views into edge hits: faster gif/video render, and the control for
the otherwise-unbounded media egress that a request-count rate limit can't bound (Range
streaming). **The origin is already CDN-ready — this is Cloudflare config, not a code change.**

### The origin is already correct (no code change)
- **Immutable + content-addressed:** success returns `Cache-Control: public,
  max-age=31536000, immutable` over `?u=ar://<txid>` — a deterministic key whose bytes
  never change (`app/api/img/route.ts`, header emitted at lines 301/317/328/337). Never
  needs revalidation.
- **Errors can't poison the cache:** 413 (line 253) and every 502 path (235/248/289/403/
  436/464) set `Cache-Control: no-store`.
- **Range/video:** forwards `Range` (lines 238–239), returns 206 + `Accept-Ranges` /
  `Content-Range` (206 at 430/460/495/527; headers at 427–428/457–458/486–487/510–512).
- **Rate-limiting survives behind the CDN:** `cf-connecting-ip` is honored
  (`lib/ratelimit.ts:11`), so per-IP limits read the real client, not Cloudflare.
- **Feed GETs already share-cacheable:** viewer-independent `/api/timeline`
  (trending/featured/default) and `/api/moments` emit `public, s-maxage=30,
  stale-while-revalidate=120` (`app/api/timeline/route.ts:634`); viewer-dependent variants
  emit `private, no-store` (line 633).
- **`?w=` resize variants are also disk-cached at the origin** (persisted
  `.next/cache/kismet-img` volume + single-flight compute,
  `lib/media/imgVariantCache.ts`): an edge miss on a resized still costs the origin a
  local file read, not a full gateway download + sharp job. The CDN stays the
  edge/egress control; this bounds the origin's share of each miss.

### Cloudflare configuration (the actual change)
1. **Cache Rule for `/api/img` — CRITICAL.** Cloudflare does **not** cache `/api/*` or
   query-string URLs by default, so the immutable header does nothing until a rule makes
   the path eligible. **When:** `URI Path equals /api/img`. **Then:** *Eligible for cache*
   = ON; *Edge TTL* = **Respect origin** (honors the 1-year header). **Cache key:** keep
   the query string (`?u=` is the content identity, so each asset caches separately);
   exclude cookies/headers (no per-user variance).
2. **Feed GETs (optional).** `URI Path equals /api/timeline` or `/api/moments` → *Respect
   origin* (honors `s-maxage=30` + SWR). Leave viewer-dependent timeline variants alone —
   the origin marks them `no-store` and Cloudflare obeys.
3. **Next static + image optimizer.** Cache `/_next/static/*` (immutable long-cache
   automatically) and `/_next/image` (its own 31-day TTL, `next.config.mjs:80`).

### Object-size reality (the one limit)
Cloudflare caches objects up to **512 MB** (Free/Pro/Business), **5 GB** (Enterprise).
Kismet's own uploads are capped at **420 MB** (`components/MintForm.tsx:275`,
`components/MomentDetailView.tsx:195`) → **every Kismet-minted image + video fits →
near-total offload on any plan.** The only bypass is a rare tail of >512 MB
legacy/externally-sourced media (`/api/img` allows up to 2 GB), which streams through to
origin uncached — acceptable. Revisit with Enterprise (5 GB) or a media path (Cloudflare
Stream / R2 / sub-512 MB renditions) only if that tail proves heavy in egress metrics.

### Range / video behavior
Cloudflare caches the **full object**, then serves byte-range slices from cache. On the
first Range request for an uncached asset it fetches the full object from origin (the
route returns a full `200` when no `Range` is sent), caches it, and serves the range.
Seek/resume works through the edge with one origin full-fetch per asset.

### Purge
- **`/api/img` is immutable → no scheduled purge.** Purge a single URL only to evict a
  rare poisoned asset (a flaky gateway can return `200` with a bad body, cached
  immutably): Cloudflare → *Purge by URL* `https://<host>/api/img?u=ar://<txid>`.
- **ISR/feed pages:** `revalidateTag` / `revalidatePath` do **not** purge the CDN
  (`SCALING.md` A7). The feed GETs use a short `s-maxage` (30 s) so staleness self-heals;
  if on-demand revalidation is added later, wire a CDN purge for **both** the HTML and RSC
  variants.

### Verify (post-deploy)
```sh
HOST=https://kismet.art
TX=<ar-txid-of-a-known-image>;  VID=<ar-txid-of-a-known-video>

# 1. immutable header, and MISS → HIT on the second fetch
curl -sI "$HOST/api/img?u=ar://$TX" | grep -iE 'cache-control|cf-cache-status'
curl -sI "$HOST/api/img?u=ar://$TX" | grep -i  'cf-cache-status'   # expect: HIT
# 2. Range works through the edge
curl -sI -H 'Range: bytes=0-1023' "$HOST/api/img?u=ar://$VID" | grep -iE 'content-range|cf-cache-status'  # 206 + Content-Range
# 3. errors are NOT cached
curl -sI "$HOST/api/img?u=ar://deadbeef" | grep -i 'cache-control' # expect: no-store (502)
```
Pass criteria: `cf-cache-status: HIT` on the 2nd image fetch · `immutable` present ·
Range → `206` with `Content-Range` · error path `no-store`.

### What NOT to do
- Don't add a request-count rate limit to `/api/img` — Range streaming behind
  carrier-grade NAT would 429 real viewers; the per-request size cap + the CDN are the
  controls (`SCALING.md §9`).
- Don't cache viewer-dependent feeds — they're `no-store` for a reason.
- Don't strip the query string from the `/api/img` cache key — `?u=` *is* the asset identity.

---

## 4. Later (architectural — real redundancy)

- **Run ≥2 replicas behind Traefik** for zero-downtime deploys + crash survival.
  Prerequisite: a **shared Redis cache handler** for ISR/image cache (`SCALING.md` B4); the
  background sweep already uses a Redis leader lock and sessions are Redis-backed, so
  requests are otherwise stateless.
- **Move the timeline off fan-out-on-read** to a materialized/global feed (`SCALING.md` B1)
  — removes the in-memory merge/sort entirely.
- **Stream `/api/transcode-gif`** source→tempfile→ffmpeg→output instead of buffering, so
  the source cap can rise without an off-heap spike.
