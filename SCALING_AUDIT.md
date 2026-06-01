# Kismet — Scaling & Infrastructure Audit

_A review of every API, dependency, and piece of infrastructure, the limits of
the current implementation, and how to position for scale._

Generated from a full read of the codebase (app/, lib/, hooks/, providers/,
Dockerfile, next.config, env template) plus a dependency audit. Line references
are `file:line`.

---

## 0. TL;DR — the five things that will break first

| # | Constraint | Where | Breaks around | Fix class |
|---|-----------|-------|---------------|-----------|
| 1 | **Feed is fan-out-on-read**: every feed load fetches `/timeline?collection=X` from inprocess for *every tracked collection in parallel*, then merges/sorts in memory. Personalized feeds (`profile/following/collected/airdroppable`) are `no-store` → zero cache. | `app/api/timeline/route.ts:145` | Low hundreds of collections, or a traffic spike on profile pages | Materialized feed / inprocess-side global timeline |
| 2 | **`created-mints` SMEMBERS pulls one set member per mint *ever*** into a JS Set on every Mints-feed cold read. | `lib/kv.ts:103`, `app/api/timeline/route.ts:224` | ~50–100k mints | Move scope filter server-side / bounded window |
| 3 | **Fan-out-on-write notifications**: one mint by a creator with N followers = N Redis writes + N Farcaster pushes. | `lib/notifications.ts:211`, `lib/follows.ts:38` | First creator with 10k+ followers | Pull-model feed / async queue |
| 4 | **inprocess.world is a hard single dependency** for *all* content + the gas-sponsored mint relay (shared API key). | `lib/inprocess.ts:4`, `lib/mint-proxy.ts` | Their rate limits / any outage | Caching, circuit breaker, contractual capacity |
| 5 | **Single Upstash Redis is the only datastore** for all platform state; per-command billing + REST round-trips scale with traffic. | `lib/redis.ts` | Command/bandwidth quota under load | Tiered cache, fewer round-trips, plan tier |

Everything below expands on these and the long tail.

---

## 1. Architecture at a glance

**Stack:** Next.js 15.5 (App Router) · React 19 · TypeScript · Node 22 (Alpine).

**Two stateful backends — there is no SQL database:**
1. **Upstash Redis** (`@upstash/redis` REST SDK, `lib/redis.ts`) — *all* platform-owned
   state: collections registry, notifications, follows graph, listings, quotas,
   rate limits, sessions, gate/blacklist, pass-validity ledger, moment metadata,
   trending/featured, Farcaster push tokens, caches.
2. **inprocess.world API** (`https://api.inprocess.world/api`, `lib/inprocess.ts:4`) —
   the source of truth for everything on-chain-indexed (timeline, moments,
   collections, payments) **and** the relay that submits sponsored on-chain
   userOps (mint / write / airdrop / distribute) under a shared `INPROCESS_API_KEY`
   via a CDP "operator smart wallet."

**Permastorage:** Arweave via ArDrive **Turbo SDK** (media + metadata),
funded by a platform wallet / `paidBy` credit approvals.

**Chain:** Base L2 (viem/wagmi) for on-chain reads and user-signed mint txs;
Ethereum mainnet RPC for ENS only.

**Social / distribution:** Farcaster Mini App (hub webhook verify, `api.farcaster.xyz`
for profile + primary-address, Quick-Auth JWT, native push to host URLs);
Alchemy NFT-activity webhook (inbound) for Pass transfers; WalletConnect/RainbowKit
for wallet connect; AR.IO + IPFS gateway pool for content delivery.

**Hosting:** Self-hosted on **Oracle Cloud (Ampere ARM)** via **Coolify**, Docker
`output: 'standalone'` (~200 MB image), non-root, single mounted volume for
`.next/cache` (ISR + image optimizer). Optional Cloudflare in front
(`cf-connecting-ip` is honored in `lib/ratelimit.ts:9`).

**Topology reality:** the code is written to be **multi-pod-aware** (Redis leader
lock for background sweeps `lib/leaderLock.ts`; process-local memo caches with
explicit cross-pod staleness comments `lib/memoCache.ts`; readiness/health probes
that talk in terms of pods + LB). But the deployment — one Coolify host with a
single mounted cache volume — is **effectively single-instance / vertically
scaled today.** Horizontal scaling is possible but carries the caveats in §5.

---

## 2. The feed architecture — primary scaling cliff (fan-out-on-read)

`app/api/timeline/route.ts` is the hottest path and the dominant constraint.

What it does on **every** request (`:129`–`:145`):
1. `getTrackedCollectionsByScope()` → the full set of tracked collections.
2. `Promise.all(collections.map(c => fetchCollection(c, fetchLimit)))` — **one
   inprocess `/timeline` fetch per collection, in parallel.**
3. Flatten → dedupe → KV-stitch creator overrides (`getMomentMetaBatch` MGET) →
   filter (scope/creator/collector/hidden/featured) → sort → **paginate after
   fetching everything.**

Consequences as the catalog grows:
- Cost per uncached feed load = **O(number of tracked collections)** upstream
  fetches + an in-memory merge/sort of up to `collections × fetchLimit` moments.
  `fetchLimit = page*limit`, bumped to ≥200 for trending/featured/roster
  (`:144`). At, say, 500 collections × 200 = up to 100k moments pulled, parsed,
  merged and sorted **in a single Node request** to render 20.
- **Personalized feeds bypass all caching.** `viewerDependent` requests
  (`creator=`, `collector=`, `following=`, `airdroppable=`) return
  `private, no-store` (`:454`–`:458`). Every profile view, "following" feed and
  Collected tab re-runs the full fan-out with **zero** cache. As users grow,
  these uncached requests dominate and multiply load on inprocess.
- Non-personalized feeds get `s-maxage=30, stale-while-revalidate=120` and the
  per-collection inprocess fetch has `next:{revalidate:30}` — good, but the
  Next fetch cache is **per-pod on local disk**, so each pod re-fans-out
  independently.

Guardrails already in place (good): page capped at 100, limit at 100 (`:53`–`:54`)
to stop a cheap-request→expensive-amplification DoS.

**Positioning for scale:** this needs a **materialized/precomputed feed** — either
inprocess exposes a *global* timeline (sorted across collections server-side, with
cursor pagination) so the client stops fanning out, or Kismet maintains its own
denormalized feed index (a capped per-scope ZSET of recent `address:tokenId`
keyed by `created_at`, written on mint, read with `ZRANGE`+pagination, hydrated
from a moment-meta cache). Either removes the O(collections) fan-out and the
full-catalog in-memory sort.

---

## 3. Fan-out-on-write — second cliff (notifications / follower graph)

- `fanoutToFollowers()` (`lib/notifications.ts:211`) does
  `getFollowers(source)` → `Promise.all(followers.map(writeNotification))`.
- `getFollowers` is `SMEMBERS kismetart:followers:<addr>` (`lib/follows.ts:38`) —
  an **unbounded set**; for a popular creator it returns the entire follower list.
- So **one mint by a creator with N followers = 1 big SMEMBERS + N notification
  writes** (each a ZADD + dedup checks + an `isPriority` lookup that itself does
  `isFollowing` + `sismember KEY_PROFILES`) **+ up to N Farcaster push HTTP POSTs**
  (`dispatchFarcasterPush`, `lib/farcasterNotifications.ts:527`).

It runs inside `after()` so it doesn't block the response, but it saturates the
Upstash command budget and the single instance's event loop the moment a
notable creator with tens of thousands of followers posts. This is the classic
"celebrity fan-out" problem.

Per-user notification storage is well-bounded (capped at 200 via
`ZREMRANGEBYRANK`, lazy TTL cleanup, cached unread count) — the problem is the
**write amplification**, not per-user storage.

**Positioning for scale:** move to a **pull model** for the high-fan-out types
(reader assembles "from creators I follow" at read time against a small per-creator
"recent activity" list) and/or push fan-out work onto a **real queue/worker**
(BullMQ/QStash) with batching, instead of inline `Promise.all` over the whole
follower set in the request lifecycle.

---

## 4. Data layer — Upstash Redis (the central constraint)

All findings below are command/payload concerns under Upstash's **per-command +
per-REST-round-trip** model. Two failure policies are used deliberately:
`safeRead` (degrade) vs `strictRead` (propagate) — `lib/redisRead.ts`; rate limits
and quotas **fail open** (`lib/ratelimit.ts:39`, `lib/userQuota.ts:137`).

### 4a. Unbounded sets read in full (`SMEMBERS`) — the dangerous ones

| Key | Read site | Growth | Risk |
|-----|-----------|--------|------|
| `kismetart:created-mints` (`<addr>:<tokenId>` per mint) | `lib/kv.ts:103`, used by Mints feed `timeline:224` | **+1 per mint ever** | **Critical** — full set → JS Set on cold read |
| `kismetart:collections` / `created-collections` | `lib/kv.ts:60,87` | +1 per collection | High (memoized 5 min mitigates) |
| `kismetart:followers:<addr>` / `following:<addr>` | `lib/follows.ts:38,35` | +1 per edge | High for popular nodes (drives §3) |
| `kismetart:collected:<addr>` (ZSET, `ZRANGE 0 -1`) | `lib/collected.ts`, `timeline:118` | +1 per collect, per user | Med-High for heavy collectors |
| `kismetart:hidden-moments` / `hidden-collections` / `hidden-users` | `lib/hidden*.ts` | +1 per hide | Med (memoized 5 min); read on most feeds |
| `kismetart:featured` (ZSET `ZRANGE 0 -1`) | `app/api/featured/route.ts` | +1 per curate | Med (admin-bounded) |
| `kismetart:listings` (ZSET) + `kismetart:listing:<id>` (MGET) | `lib/listings.ts` | +1 per listing | Med; bounded scan, but no hard TTL trim |

The mitigation pattern already used — `memoize()` (`lib/memoCache.ts`, process-local
TTL + single-flight) — cuts **frequency** of these reads but not their **payload
size**, and is **per-pod** (5-min cross-pod staleness, acknowledged in comments).

### 4b. Correctly bounded (good)

- **`kismetart:trending`** is **capped at 10k on every collect** via
  `ZREMRANGEBYRANK(TRENDING_KEY, 0, -10001)` inside the collect MULTI
  (`app/api/collect/route.ts:230`). The feed reads `ZRANGE 0 9999` — a sizable
  but bounded payload, not unbounded. _(Corrects a common misread.)_
- Notifications per user capped at 200 (`notifications.ts:179`) with 60-day lazy
  TTL; trending/notif background sweeps were intentionally replaced by
  inline-on-write / lazy-on-read trimming.
- Pass-validity idempotency/credit/processed flags carry 30–90-day TTLs.
- Rate-limit (`rl:*`), nonces, sessions, quota buckets, leader locks all have TTLs.
- Showcase pins capped at 4/category; airdrops capped at 500/sender.

### 4c. Per-request command volume (clarification)

Each authenticated API request issues a **handful** of Redis commands — typically
1 rate-limit `EVAL` + 1 session `GET` (+ optional sliding `EXPIRE`) + the route's
actual reads/writes. (It is **not** "40 commands per request" — 40 is the number
of *distinct rate-limited endpoints* across the app.) Still, aggregate command
count scales linearly with traffic, and the big-payload `SMEMBERS`/`MGET`/`ZRANGE`
reads in §4a are what move the Upstash **bandwidth** needle.

### 4d. Large values in Redis

- `kismetart:moment-content:<addr>:<tokenId>` stores writing-moment bodies up to
  **10 MB** each (`lib/mint-proxy.ts:25`, `MAX_TOKEN_CONTENT_BYTES`). Many large
  text moments inflate Redis memory; consider Arweave/object storage for the body
  with Redis holding only a pointer.

**Positioning for scale:** (1) treat Redis as a **cache + counters layer**, not the
system of record, for anything that grows with mints/users; push list-shaped truth
to inprocess or a real DB with indexed pagination. (2) Replace whole-set reads
with bounded/paginated reads (`SSCAN`, `ZRANGE` windows, `SCARD` instead of
`SMEMBERS` for counts — already done for follower *counts*). (3) Size the Upstash
plan to observed command + bandwidth, and add Upstash usage alerts.

---

## 5. Compute & infrastructure

**Host / orchestration:** Oracle Ampere ARM + Coolify + Docker standalone. The
build is **memory-constrained** — `next.config.mjs` runs SWC with `cpus:1` and
`webpackMemoryOptimizations`, `NODE_OPTIONS=--max-old-space-size=4096`, and
`typescript.ignoreBuildErrors` / `eslint.ignoreDuringBuilds` (checks run in
`npm run check` pre-merge instead, since there is **no CI** — see §7). This means
the builder OOMs before it scales; build headroom is a real operational limit.

**Runtime traits:**
- `output: 'standalone'`, runs `node server.js` directly so SIGTERM → graceful
  shutdown (good). Non-root user.
- **`/api/img`** streams up to **2 GB** of media through the Node process
  (`app/api/img/route.ts:13`), SSRF-guarded to ar://+ipfs:// only, 1-year immutable
  cache header — but **no auth and no rate limit.** Without a CDN in front, every
  video view streams through the single box (egress + sockets). The immutable
  header makes a CDN/Cloudflare extremely effective here; **fronting `/api/img`
  with a CDN is the single highest-leverage infra change.**
- **`/api/transcode-gif`** is CPU/memory-heavy ffmpeg with an **in-process
  semaphore of 1** (`route.ts:25`) and `maxDuration=300`. Globally serialized on a
  single instance → a queue bottleneck under load (others get 503). Fine for now;
  needs a worker/off-box transcode service to scale.
- Background sweeps run via `setInterval` in the long-lived process under a Redis
  leader lock (`lib/backgroundTasks.ts`) — correct for multi-pod.

**What degrades if you simply add pods today:**
- Process-local `memoize` caches → up to 5-min cross-pod inconsistency on
  collection/hidden sets (acknowledged).
- Next.js **fetch revalidate cache and ISR/image cache are per-pod on local
  disk** (single mounted `.next/cache` volume). Multiple pods either fight over
  one volume or duplicate work. Image optimization re-runs per pod.
- ⇒ Horizontal scale wants: a **shared cache** (Redis/CDN) for image+fetch layers
  or acceptance of per-pod duplication, and sticky-free statelessness (sessions
  are already Redis-backed, so requests are stateless — good).

**Readiness coupling (resilience risk):** `/api/readiness` returns 503 (pod pulled
from LB) if **Base RPC** `getBlockNumber()` fails (`app/api/readiness/route.ts:51`).
A Base RPC provider blip therefore can pull **every** pod from the LB and dark the
whole site — even for read-only browsing that doesn't need RPC. Consider making RPC
a *soft/degraded* signal rather than a hard readiness gate.

---

## 6. External APIs & dependencies — limits and failure modes

### 6a. inprocess.world (`api.inprocess.world`) — **the** dependency
- **Reads:** `/timeline` (fanned out, §2), `/moment` (also fetched **per feed card**
  client-side in `MomentCard` for price — a fetch storm on every feed render),
  `/collection`, `/collections`, `/payments`, smart-wallet resolution.
- **Writes/relay:** `/moment/create`, `/moment/create/writing`, `/airdrop`,
  `/distribute` — submit **sponsored on-chain userOps** under the shared
  `INPROCESS_API_KEY` (gas paid by the platform operator wallet).
- **Timeouts:** inconsistent. Mint relay 60 s (`mint-proxy.ts:32`), distribute 45 s,
  `fetchCollectionMoments` 8 s default — but `/api/moment`, `/api/payments`,
  `/api/moment/comments`, and the timeline fan-out fetch have **no per-call
  AbortController**; a hung upstream stalls the request until the platform kills it.
- **Failure mode:** most reads degrade to `[]`/KV fallback (good). But inprocess
  being a single upstream for *all* content means **its rate limits, latency, and
  uptime are your ceiling**, and the §2 fan-out *multiplies* your load on it.
- **Positioning:** add uniform per-call timeouts + a circuit breaker; coalesce the
  per-card `/api/moment` price fetches (batch endpoint or stitch server-side with a
  warm cache); confirm contractual/throughput limits and an API-key spend ceiling.

### 6b. Arweave / ArDrive Turbo — **the spend backstop**
- `/api/sign` (`app/api/sign/route.ts`) signs 48-byte deep-hash chunks so media
  streams **client → Turbo** directly; the server **never sees the bytes and
  cannot meter them.** Hard ceiling on catastrophic drain = **the funding wallet
  balance** (documented in `.env.example`). Controls: IP rate limit (10/min),
  per-address `sign-calls` quota (200/day), and operational balance capping.
- `/api/upload` (JSON metadata, 50 MB cap, 500 MB/day/address) and
  `/api/transcode-gif` are metered by byte quota.
- **Positioning:** keep the funding wallet on a **bounded float with balance
  alerts** (`payment.ardrive.io/v1/balance/...`); the quota is per-identity and
  fails open, so the wallet balance is the real stop. Consider tightening
  `sign-calls` and adding a global daily sign ceiling, not just per-identity.

### 6c. Base + Ethereum RPC (viem/wagmi)
- **RPC URLs are `NEXT_PUBLIC_*`** (`lib/wagmi.ts:155,162`, `lib/rpc.ts:17`) — the
  paid RPC keys are **shipped in the client bundle.** At scale your RPC quota is
  consumed by scrapers/the public, and there's **no fallback/rotation** (single
  endpoint; falls back to rate-limited `mainnet.base.org`).
- Multicall batching is on (good). Server reads (collect verification, permission
  checks, collect-all eligibility) hit the same single endpoint.
- **Positioning:** move server-side RPC to a **server-only** key (`rpc.ts` already
  reads `NEXT_PUBLIC_BASE_RPC_URL` — add a `BASE_RPC_URL` server var like the ENS
  one already does); add a second provider for failover; rate-limit/proxy any
  client RPC or use a per-domain-restricted key.

### 6d. Farcaster
- `api.farcaster.xyz` is hit for **primary-address + profile** resolution, cached
  1 h / 5 h in Redis (`lib/farcasterAuth.ts`, `lib/farcasterProfile.ts`) but is on
  the **per-request path for Mini App users** on cache miss. Hub used only for
  webhook signature verify. Quick-Auth JWT verified locally (no network).
- Native **push** POSTs to host URLs are SSRF-guarded, timed out (10 s), chunked
  ≤100 tokens, idempotent, GC-invalid-tokens — well built; the only scale concern
  is the §3 fan-out volume.
- **Positioning:** lengthen cache TTLs / negative-cache misses; consider Neynar
  (already noted in env) for higher quota.

### 6e. Alchemy webhook (inbound)
- `/api/webhooks/pass-transfer` — HMAC-SHA256 timing-safe verify, must be NFT
  Activity type. Critical for off-platform Pass revocation/taint. Single webhook;
  if Alchemy delays/drops, gate convergence lags (on-platform direct-credit covers
  the common case). Low scaling risk; **operational** dependency.

### 6f. WalletConnect / RainbowKit / IPFS+AR.IO gateways
- WalletConnect needs `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`; relay is theirs.
- Gateway pool is **raced** server-side in `/api/img` and on the client with 404
  fallthrough — resilient. Content is content-addressed → 1-year immutable caching.

---

## 7. Dependencies & supply chain

**`npm audit`: 67 vulnerabilities (3 critical, 8 high, 40 moderate, 16 low).**
Concentrated in two transitive subtrees, not in app code:
- **Arweave/Turbo** (`@ardrive/turbo-sdk` → `@dha-team/arbundles` **critical**,
  the `@cosmjs/*`, `@ethersproject/*` v5, `elliptic`, `secp256k1` chain). Fix is a
  **major** turbo-sdk bump.
- **Coinbase CDP SDK → axios (high)** and the **`@reown/appkit*` / WalletConnect**
  cluster (many moderate) pulled via RainbowKit/wagmi.

These are mostly crypto-signing transitive deps; few are reachable in a way that
affects the server, but the **critical arbundles** finding (used by the upload
path) deserves a tracked upgrade. **There is no automated dependency/security
scanning** because there's **no CI** (`.github/` absent; checks are local-only via
`npm run check`).

**Version posture (good):** Next 15.5, React 19, Node 22 LTS, viem 2 / wagmi 2 —
all current. Engines pin `node >=22.11`.

**Positioning for scale:**
- Add **CI** (GitHub Actions): run `npm run check` (typecheck + lint +
  resource-hint + bundle-size), `npm audit --omit=dev`, and a Docker build, on
  every PR. Today nothing enforces the gates the code comments rely on.
- Add **Dependabot/Renovate**; schedule the turbo-sdk major bump and CDP/axios fix.
- Pin/track the `bundle-baseline.json` budget in CI (the script exists,
  `scripts/check-bundle-size.mjs`, but isn't enforced anywhere automated).

---

## 8. Client-side scale (UX & bandwidth, not server)

- **Bundles are heavy:** shared `/layout` baseline ~**2.0 MB** JS; per-page ~1.1–1.2 MB
  (`bundle-baseline.json`). Driven by the web3 stack (wagmi/viem/RainbowKit +
  Farcaster SDKs) and ffmpeg.wasm. At scale this is a mobile conversion + egress
  cost; ffmpeg-core is already copied to `public/` and loaded on demand, and the
  FC SDK is dynamically imported — keep pushing heavy deps behind dynamic imports
  and route-level code-splitting.
- **Per-card `/api/moment` fetch storm** on feed render (no client dedupe/coalesce)
  multiplies inprocess load — see §6a.
- **In-memory client caches** are bounded LRUs (`lib/lruCache.ts`, used by
  moment/profile/collection/text caches) — good — **except `lib/media/durationCache.ts`**,
  which is a bare unbounded `Map` (no LRU/TTL); a long browsing session over a
  large video catalog grows it without bound. Low severity, easy fix (wrap in
  `LRUCache`).

---

## 9. Security/abuse controls (already strong; scale notes)

Layered and well-considered: intent-signature verification on mint/write
(`lib/intentAuth.ts`), httpOnly session cookie + FC JWT fallback, per-identity
quotas (`lib/userQuota.ts`), IP rate limits on ~40 endpoints, action + pass
blacklists, gate/pause kill switch, on-chain verification before crediting
collects, idempotency keys everywhere, SSRF guards on the proxy + push URLs,
`__Host-` cookie prefix, timing-safe webhook HMAC.

Scale-relevant gaps:
- **`/api/img` and `/api/listings POST` lack rate limits** (img is the bigger
  egress risk; listings POST does EIP-712 recovery + RPC per call). Add IP limits.
- Rate limits and quotas **fail open** — correct for availability, but means a
  Redis outage removes all spend/abuse ceilings simultaneously. Pair with the
  wallet-balance backstop and Upstash alerting.
- Quotas/rate limits are per-IP or per-identity; **no global ceilings** on
  platform-paid resources (gas via inprocess key, Arweave spend). Add aggregate
  daily caps as a circuit breaker.

---

## 10. Prioritized roadmap

**Now (days) — cheap, high-leverage, no architecture change:**
1. **Front `/api/img` (and static/feed GETs) with a CDN/Cloudflare.** Immutable
   content-addressed media → near-100% offload of the 2 GB-streaming path off the
   single box. Add an IP rate limit to `/api/img` and `/api/listings POST`.
2. **Move server RPC to a server-only key + add a failover provider**; decouple
   `/api/readiness` from a hard Base-RPC gate (degrade, don't dark).
3. **Add CI** (typecheck/lint/bundle/audit/build) and Dependabot; schedule the
   **critical arbundles / turbo-sdk** and **axios/CDP** upgrades.
4. **Uniform per-call timeouts + circuit breaker** on all inprocess fetches;
   wrap `durationCache` in `LRUCache`; add Upstash + wallet-balance alerts.

**Next (weeks) — relieve the cliffs without re-platforming:**
5. **Kill the per-card `/api/moment` fetch storm** — batch price/sale lookups or
   stitch server-side against a warm moment cache.
6. **Bound the big reads:** replace `created-mints` full-`SMEMBERS` membership with
   a server-side scope filter (inprocess) or a bounded recent-window; paginate
   `collected`/`listings`/`featured` reads.
7. **Move fan-out notifications to a queue** (QStash/BullMQ) with batching; cap or
   pull-model the high-follower case.

**Architectural (the real scale unlock):**
8. **Replace fan-out-on-read feed** with a materialized/global timeline — either
   inprocess exposes a cross-collection sorted+cursor-paginated timeline, or Kismet
   maintains its own denormalized feed index (capped ZSETs by scope, hydrated from
   a moment-meta cache). This removes both the O(collections) upstream fan-out and
   the full-catalog in-memory sort, and makes personalized feeds cacheable.
9. **Introduce a system-of-record DB** (Postgres) for list-shaped, growing state
   (collections, listings, follows, notifications, collected) with proper indexes
   and pagination; demote Redis to cache + counters + locks. This is what lets you
   run **many stateless pods** behind the LB without the per-pod cache-coherence and
   whole-set-read problems.
10. **Off-box media transcode** (worker/service or a media API) so ffmpeg stops
    being a single-instance, globally-serialized bottleneck.

---

_Corrections folded in vs. first-pass automated scans: `trending` is bounded to
10k (write-side `ZREMRANGEBYRANK`), not unbounded; rate-limiting is ~per-endpoint,
not 40 commands/request; writing-moment bodies cap at 10 MB, not 200 KB._
