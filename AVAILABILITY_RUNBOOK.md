# Kismet — Availability Runbook ("no server available" / "bad gateway")

_Why the single container was going down, what this PR changed in-repo, and the
Coolify/ops changes you still must make. Companion to `SCALING_AUDIT.md` (scale
cliffs) and `REMEDIATION_PLAYBOOK.md` (source-grounded fixes). This file is
about acute **uptime** of the one container, not scale._

## TL;DR — what the two errors mean here

We run **one** Docker container on **one** Oracle Ampere host via Coolify
(Traefik proxy). With a single instance there is zero redundancy, so:

- **"bad gateway (502)"** = the lone `node server.js` died mid-request (kernel
  cgroup **OOM-kill** / crash), so Traefik got a closed connection.
- **"no server available"** = Traefik has **zero healthy backends** — the one
  pod is down/restarting, or was evicted by a failing health check.

Both collapse to the same root: **the one process dies or gets pulled, and
there is no peer to absorb it.** The fix set is two-pronged — *stop the
deaths/evictions* (in-repo) **and** *survive + recover fast* (ops).

---

## Confirmed root causes (adversarially verified against the code)

| # | Cause | Error | Fixed in this PR? |
|---|-------|-------|-------------------|
| 1 | **⭐ CONFIRMED: V8 JS-heap OOM at ~2 GB every ~45 min** — no cgroup limit ⇒ V8 used its ~2 GB default while the 11 GB host sat ~9 GB idle; timeline fan-out grew the heap until it died (`FATAL ERROR: ...JavaScript heap out of memory`). **THE crash behind your errors.** | both | ✅ heap cap (`--max-old-space-size=4096`) + timeline `MERGE_BUDGET` |
| 2 | **Readiness hard-gated on one 3s Upstash ping** (NB: Coolify actually gates on `/api/health`, so this is dormant/future-proofing) | no server available | ✅ in-repo (dormant) |
| 6 | **Auto-pipelining co-batched the readiness ping** behind a fat Redis payload → false-slow ping → false 503 | no server available | ✅ in-repo |
| 9 | **Blocking cold start** — `register()` awaited an on-chain RPC healthcheck + an unbounded `SMEMBERS` warmup before serving, widening every restart's dark window | no server available | ✅ in-repo |
| 10 | ~~No process-level crash handlers~~ — **non-issue (see Refuted)**: Next 15's server already installs log-and-continue handlers that keep the single process alive | both | N/A — framework-provided |
| 3 | **Timeline fan-out** held `collections × up-to-10,000` moments in heap to render 20 (OOM at low-tens of dense collections) | 502 (OOM) | ✅ in-repo |
| 5 | **Timeline fan-out fetches lacked timeouts + concurrency cap** → a slow inprocess piles up handlers/sockets | both | ✅ in-repo |
| 7 | **`/api/transcode-gif` buffers up to 300MB** + ffmpeg + sharp | 502 (OOM) | Bounded by the `MAX_CONCURRENT=1` semaphore + the ops memory limit; streaming refactor is the follow-up |
| 4 | **`/api/img` unbounded streaming concurrency**, no CDN | 502 (aggregate RSS) | Ops — **CDN** (see `CDN_RUNBOOK.md`) |

**Refuted — do not chase:** unbounded `SMEMBERS` as an *OOM* (it hard-fails at
Upstash's 10MB cap → a 500, not a SIGKILL); an event-loop-wedge cascade
(measured well under the probe budget); `after()`-callback crashes (all
wrapped); `/api/img` raw-stream-error crash (Next 15 wraps it); `maxDuration`
as a real handler timeout (it's a Vercel no-op on self-hosted `node server.js`);
**"no process-level crash handlers"** — Next 15's production server
(`next-server.js`) already installs `uncaughtException`/`unhandledRejection`
handlers that **log and keep the process alive** (React-postpone aware). Adding
our own `uncaughtException → process.exit(1)` would have *overridden* that and
crashed the single container Next intended to keep serving — a regression we
caught in review and removed. Crash survival is the framework's job here.

---

## What this PR changed (in-repo)

- **`instrumentation.ts`** — de-blocks cold start: the on-chain healthcheck,
  cache warmup, and backfill now run fire-and-forget so `register()` returns
  instantly (Next awaits it before listening, so anything awaited there widens
  every restart's dark window), and drops the unbounded `getCreatedMintsSet()`
  from the warmup. Process-level crash survival is intentionally left to Next
  15's own log-and-continue handlers (see the file docstring + Refuted above).
- **`app/api/readiness/route.ts`** — dedicated **non-pipelined** Upstash client
  for the probe (so the ping's latency reflects Redis health, not a co-batched
  payload), plus **consecutive-failure tolerance** (only 503 after 3 failures
  in a row, so a single blip can't evict the only pod). A sustained outage
  still trips it.
- **`app/api/timeline/route.ts`** — bounds the total moments pulled into the
  merge via a fixed budget distributed across the fan-out (caps peak heap + the
  MGET stitch + the sort regardless of page depth or collection count, while
  preserving full pagination depth when only a few collections are in play);
  adds `AbortSignal.timeout(8s)` to the per-collection fetch; bounds the fan-out
  to 10 concurrent upstream fetches.
- **`lib/coverMomentSynthesis.ts`** — adds `AbortSignal.timeout(8s)` to its two
  inprocess fetches (they run inside the timeline fan-out).
- **`app/api/transcode-gif/route.ts`** — documents that the 300MB source cap is
  held bounded by the `MAX_CONCURRENT=1` semaphore + the ops memory limit (cap
  unchanged to avoid narrowing the route's purpose; streaming is the follow-up).
- **`Dockerfile`** — sets `NODE_OPTIONS=--max-old-space-size=4096` in the runner
  stage. This is the fix for the confirmed crash: production was dying at V8's
  ~2 GB default heap while the 11 GB host sat ~9 GB idle (no cgroup limit for
  Node 22 to size against). 4 GB uses the available RAM; the timeline
  `MERGE_BUDGET` cap stops the unbounded climb that was hitting the ceiling.

---

## Confirmed from production telemetry (a Coolify deploy log + Upstash metrics)

- **⭐ CONFIRMED ROOT CAUSE — V8 JavaScript heap OOM at ~2 GB, every ~45 min.**
  The container logs caught it: `FATAL ERROR: Ineffective mark-compacts near heap
  limit — JavaScript heap out of memory` at ~2030 MB, with the timeline
  `airdroppable` fan-out logged immediately before the death. This is a **V8 heap
  OOM, not a kernel/cgroup OOM** — which is why `OOMKilled=false`, `dmesg` was
  clean, and the cgroup `oom_kill` counter was 0 (all of which masked it; the
  cgroup `memory.peak` also reset to ~669 MB on each restart, hiding the true 2 GB
  peak). Two compounding causes: (1) **no cgroup memory limit** (`memory.max =
  max`) ⇒ Node 22 fell back to V8's **~2 GB default heap** while the **11 GB host
  had ~9 GB free** — it died with most of the box idle; (2) the **timeline
  fan-out merge** grew the heap unbounded over ~45 min until it hit 2 GB. Each
  crash + slow restart = a "no server available" / "bad gateway" window. **Fix:
  raise the heap (`NODE_OPTIONS=--max-old-space-size=4096`, now in the Dockerfile)
  + the timeline `MERGE_BUDGET` cap in this PR that bounds the growth.** (Secondary
  contributor in the same log: `next/image` choking on ~50 MB Arweave images.)
- **Cold-start blocking was real.** The first `/api/health` probe on a freshly
  booted container **timed out (>5s)**, then passed in ~0.15s once warm — exactly
  the symptom of `register()` blocking serving on its awaited RPC + (cross-region)
  Redis warmup. The de-block fix in this PR shrinks the restart-window outage that
  follows each heap-OOM crash above.
- **Deploys are clean.** Coolify does a health-gated rolling update (new
  container must pass `/api/health` before the old is removed), so "no server
  available" is **not** a deploy artifact — it's the lone process being *down*
  (crash/restart), which makes the memory + restart-policy items below the crux.
- **Redis cost is GET-dominated.** Upstash "Top Commands" shows one command
  (GET — per-request session validation + the unread-count poll) dwarfing all
  others; `EVAL`/`SMEMBERS`/`ZRANGE` are comparatively flat. ⇒ the zero-tradeoff
  changes here (ZMSCORE, longer TTLs) help only modestly; **the real cost cut is
  the deferred process-local session cache** (Core tier).
- **Redis is in AWS `us-east-1`** while the app runs on Oracle — every Redis call
  pays cross-cloud latency, which also *amplified* the cold-start block.
  Co-locating Redis with the app (or a closer region) cuts latency on every call.

## Ops changes you MUST make in Coolify (load-bearing — not in the repo)

These are the half the repo cannot ship. On a single instance they are the
difference between "recovers in seconds" and "dark until someone notices."

1. **Raise V8's heap ceiling — this is the load-bearing fix for the confirmed
   crash.** The app was dying at V8's ~2 GB default heap while the 11 GB host had
   ~9 GB free. The Dockerfile now sets `NODE_OPTIONS=--max-old-space-size=4096`,
   but the **fastest relief is a Coolify env var** (Environment Variables →
   `NODE_OPTIONS=--max-old-space-size=4096`), which applies on the next restart
   with no rebuild and overrides the image default. 4 GB leaves headroom under
   11 GB even alongside a `next build`. **Optionally also set a container --memory
   limit** (e.g. 6–8 GB) — then Node 22 derives the heap from it automatically and
   the flag becomes redundant; verify with `docker inspect <c> --format
   '{{.HostConfig.Memory}}'` (`0` = none, which is the current state). Note: swap
   is likely unavailable on this kernel (the deploy log reports *"memory
   swappiness discarded / cgroup not mounted"*), so don't rely on paging — the
   heap cap + the in-code timeline `MERGE_BUDGET` bound are what prevent the OOM.
2. **Set the restart policy to `unless-stopped`** (or `always`). The single most
   important "survive a crash" lever: when the kernel OOM-kills the process (the
   primary remaining crash vector — Next survives stray exceptions), the
   container recovers in seconds instead of staying dark. Coolify generates a
   `docker-compose.yaml`; verify the `restart:` line there, or
   `docker inspect <container> --format '{{.HostConfig.RestartPolicy.Name}}'`.
   (12-Factor IX disposability.)
3. **Readiness probe is currently DORMANT — `/api/health` is the gate.** The
   deploy log confirms Coolify health-gates the rolling update on the Dockerfile
   `HEALTHCHECK` (`/api/health`, always-200), not `/api/readiness`. For a single
   instance that's the *correct* choice (you never want to evict your only pod
   for a dependency blip), so the readiness hardening in this PR is harmless
   future-proofing for a multi-pod world, not an active fix today. Only wire
   `/api/readiness` (with `failureThreshold` **3–5**) if/when you run ≥2 replicas.
   (Google SRE: never hard-gate health on a variable-latency dependency.)
4. **Put a CDN in front of `/api/img` + static** (`CDN_RUNBOOK.md`). The media
   is immutable + content-addressed, so the edge absorbs the streaming RSS/FD
   pressure the origin can't. Highest-leverage durable fix for the `/api/img`
   vector. (OWASP API4:2023 — bound paid/origin resource consumption.)

## Later (architectural — real redundancy)

- **Run ≥2 replicas behind Traefik** for true zero-downtime deploys and crash
  survival. Prerequisite: a **shared Redis cache handler** for ISR/image cache
  (`REMEDIATION_PLAYBOOK.md` §B4); the background sweep already uses a Redis
  leader lock and sessions are Redis-backed, so requests are otherwise stateless.
- **Move the timeline off fan-out-on-read** to a materialized/global feed
  (`REMEDIATION_PLAYBOOK.md` §B1) — removes the in-memory merge/sort entirely.
- **Stream `/api/transcode-gif`** source→tempfile→ffmpeg→output instead of
  buffering, so the source cap can rise without an off-heap spike.
