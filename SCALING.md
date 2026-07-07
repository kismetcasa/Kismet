# Kismet — Scaling & Remediation

_A review of every API, dependency, and piece of infrastructure; the limits of the
current implementation; how to position for scale; and — for each finding — the
researched, source-verified fix and its **current status in the code**._

> **Consolidates** the former `SCALING_AUDIT.md` (scale-cliff analysis) and
> `REMEDIATION_PLAYBOOK.md` (source-grounded fixes). Part I is the analysis; Part II
> the per-issue remediation (with primary-source citations); Parts III–V the
> corrections/upgrades research surfaced, a methodology check, and one roadmap.
> Line references are `file:line`. Companion docs: `STACK_OVERVIEW.md` (the full
> component map), `OPS_RUNBOOK.md` (single-container uptime + CDN), `VIDEO_PLAYBACK_RCA.md`.

**Status legend:** ✅ **Resolved** (shipped; evidence cited) · 🔶 **Partial / mitigated**
(hardened, but the architectural fix is still open) · ⬜ **Open** · 🛠 **Ops** (config
change outside this repo — see `OPS_RUNBOOK.md`).

## Status dashboard — what has shipped since the first audit

| # | Finding | Status | Evidence / note |
|---|---------|--------|-----------------|
| §2 | Feed fan-out-on-read | 🔶 | Bounded to `FANOUT_CONCURRENCY=10` + `MERGE_BUDGET` width cap (`timeline/route.ts:44,276,283`); **materialized feed still not built** |
| §3 | Fan-out-on-write notifications | ⬜ | Still inline `Promise.all` over followers (`notifications.ts:232`); no queue |
| §4a | `created-mints` full `SMEMBERS` | ⬜ | Still `smembers` in full (`kv.ts:115`); hardened for degradation only |
| §4d | 10 MB writing-moment bodies in Redis | ⬜ | `mint-proxy.ts:27` |
| §5 | Readiness hard-gated on Base RPC | ✅ | RPC is a `degraded` signal, non-gating; only sustained Redis failure gates (`readiness/route.ts:110,121-126`) |
| §5 | `/api/img` streams through the box | 🔶🛠 | Origin is CDN-ready; **CDN not yet fronted** → `OPS_RUNBOOK.md` |
| §6a | Per-card `/api/moment` fetch storm | ✅ | `MomentCard` no longer fetches per card; dwell-gated, deduped `useMomentSale` coalesces into one batched `/api/moments` |
| §6a | Inconsistent upstream timeouts | ✅ | `AbortSignal.timeout(8s)` now on `/api/moment`, `/api/payments`, `/api/moment/comments`, timeline fan-out |
| §6a | Circuit breaker on inprocess | ⬜ | Timeouts done; no breaker/bulkhead yet |
| §6c | RPC key server-only | ✅ | `rpc.ts:22` prefers `BASE_RPC_URL` over `NEXT_PUBLIC_*` |
| §6c | RPC failover provider | ⬜ | `batch:true` only (`wagmi.ts`); no `fallback()`/`rank` |
| §7 | "No CI / no dependency scanning" | ✅ | `.github/workflows/ci.yml` + `.github/dependabot.yml` |
| §7 | Critical `arbundles` vuln | ✅ | Cleared via root `overrides` (`package.json:63-68`); `npm audit` now **0 critical** |
| §8 | `durationCache` unbounded `Map` | ✅ | `LRUCache(512)` (`lib/media/durationCache.ts:16`) |
| §9 | `/api/listings POST` no rate limit | ✅ | Per-IP 20/60 + per-seller 5/60 (`listings/route.ts:364,464`) |

Everything marked ⬜/🔶 is expanded below; the ✅ items are retained with their
original analysis for provenance but are **done** — treat this dashboard as the
source of truth for what remains.

---

# Part I — The findings

## 0. TL;DR — the five things that will break first

| # | Constraint | Where | Breaks around | Status |
|---|-----------|-------|---------------|--------|
| 1 | **Feed is fan-out-on-read**: every feed load fetches `/timeline?collection=X` from inprocess for tracked collections, then merges/sorts in memory. Personalized feeds (`profile/following/collected/airdroppable`) are `no-store` → zero cache. | `app/api/timeline/route.ts` | Low hundreds of collections, or a spike on profile pages | 🔶 concurrency + merge budget bounded; arch fix open |
| 2 | **`created-mints` SMEMBERS pulls one member per mint *ever*** into a JS Set on every Mints-feed cold read. | `lib/kv.ts:115`, `timeline/route.ts` | ~50–100k mints (hard-fails at Upstash's 10 MB request cap) | ⬜ |
| 3 | **Fan-out-on-write notifications**: one mint by a creator with N followers = N Redis writes + N Farcaster pushes. | `lib/notifications.ts:232`, `lib/follows.ts:38` | First creator with 10k+ followers | ⬜ |
| 4 | **inprocess.world is a hard single dependency** for *all* content + the gas-sponsored mint relay (shared API key). | `lib/inprocess.ts:4`, `lib/mint-proxy.ts` | Their rate limits / any outage | 🔶 timeouts added; breaker open |
| 5 | **Single Upstash Redis is the only datastore** for all platform state; per-command billing + REST round-trips scale with traffic. | `lib/redis.ts` | Command/bandwidth quota under load | ⬜ |

## 1. Architecture at a glance

Full inventory lives in `STACK_OVERVIEW.md §1–§2`; the load-bearing facts for scale:

- **Two stateful backends, no SQL database.** (1) **Upstash Redis** (`@upstash/redis`
  REST SDK, `lib/redis.ts`) holds *all* platform-owned state; (2) **inprocess.world**
  (`https://api.inprocess.world/api`, `lib/inprocess.ts:4`) is the source of truth for
  everything on-chain-indexed **and** the sponsored-userOp relay (mint/write/airdrop/
  distribute under a shared `INPROCESS_API_KEY`).
- **Permastorage:** Arweave via ArDrive **Turbo SDK**, funded by a platform wallet /
  `paidBy` credit approvals.
- **Chain:** Base L2 (viem/wagmi) for reads + user-signed mint txs; Ethereum mainnet for ENS only.
- **Hosting:** self-hosted on **Oracle Ampere (ARM)** via **Coolify**, Docker
  `output:'standalone'`, single mounted volume for `.next/cache`. `cf-connecting-ip`
  honored (`lib/ratelimit.ts:11`).
- **Topology reality:** code is written multi-pod-aware (Redis leader lock
  `lib/leaderLock.ts`; process-local memo caches with explicit cross-pod staleness
  comments `lib/memoCache.ts`), but the deployment is **effectively single-instance /
  vertically scaled today** (§5).

## 2. The feed architecture — primary scaling cliff (fan-out-on-read)  🔶

`app/api/timeline/route.ts` is the hottest path and the dominant constraint.

On **every** request it: (1) resolves the tracked-collection set; (2) fetches one
inprocess `/timeline` per collection; (3) flattens → dedupes → KV-stitches creator
overrides (`getMomentMetaBatch` MGET) → filters → sorts → paginates **after** fetching
everything.

**Since the audit (hardening that landed):** the fan-out is no longer one socket per
collection — it runs through `mapWithConcurrency(…, FANOUT_CONCURRENCY=10, …)`
(`timeline/route.ts:44`), and the in-memory merge is bounded by `MERGE_BUDGET` (5,000;
10,000 for `creator=`/`airdroppable=`) with a hard width-truncation past
`MERGE_BUDGET` collections and a `[timeline] fan-out thinned` warn
(`timeline/route.ts:276-294`). The "500 collections × 200 = 100k moments in one
request" cliff is therefore capped, and each fan-out fetch carries an
`AbortSignal.timeout(8s)` (`timeline/route.ts:74`).

**Still open (the architecture):**
- Cost per uncached feed load is still **O(tracked collections)** upstream fetches.
- **Personalized feeds bypass all caching** — `viewerDependent` requests
  (`creator=`/`collector=`/`following=`/`airdroppable=`) return `private, no-store`.
  Every profile/following/Collected view re-runs the full fan-out with zero cache.
- Non-personalized feeds get `s-maxage=30, stale-while-revalidate=120`, but the Next
  fetch cache is **per-pod on local disk**, so each pod re-fans-out independently.

**Fix → see B1.** A materialized/precomputed feed (a capped per-scope ZSET of recent
`address:tokenId` keyed by `created_at`, written on mint, read with score-cursor
pagination) — or an inprocess-side global cursor timeline — removes both the
O(collections) fan-out and the full-catalog in-memory sort, and makes personalized
feeds cacheable.

## 3. Fan-out-on-write — second cliff (notifications / follower graph)  ⬜

`fanoutToFollowers()` (`lib/notifications.ts:232`) does `getFollowers(source)` →
`Promise.all(followers.map(writeNotification))`. `getFollowers` is
`SMEMBERS kismetart:followers:<addr>` (`lib/follows.ts:38`) — an unbounded set. So one
mint by a creator with N followers = 1 big SMEMBERS + N notification writes (each a
ZADD + dedup + `isPriority` lookup) + up to N Farcaster push POSTs
(`dispatchFarcasterPush`, `lib/farcasterNotifications.ts`). It runs inside `after()`
so it doesn't block the response, but it saturates the Upstash command budget and the
single instance's event loop the moment a large creator posts — the classic
celebrity fan-out problem. Per-user storage is well-bounded (capped 200 via
`ZREMRANGEBYRANK`, lazy TTL) — the problem is **write amplification**. **Fix → B2.**

## 4. Data layer — Upstash Redis (the central constraint)

Under Upstash's per-command + per-REST-round-trip model. Two failure policies are used
deliberately: `safeRead` (degrade) vs `strictRead` (propagate) — `lib/redisRead.ts`;
rate limits and quotas **fail open** (`lib/ratelimit.ts`, `lib/userQuota.ts:145`).

### 4a. Unbounded sets read in full (`SMEMBERS`) — the dangerous ones  ⬜

| Key | Read site | Growth | Risk |
|-----|-----------|--------|------|
| `kismetart:created-mints` (`<addr>:<tokenId>` per mint) | `lib/kv.ts:115`, Mints feed | **+1 per mint ever** | **Critical** — full set → JS Set on cold read; **hard-fails** past Upstash's 10 MB request cap (~200k members), not just slow |
| `kismetart:collections` / `created-collections` | `lib/kv.ts:73,98` | +1 per collection | High (memoized 5 min mitigates) |
| `kismetart:followers:<addr>` / `following:<addr>` | `lib/follows.ts:38,35` | +1 per edge | High for popular nodes (drives §3) |
| `kismetart:collected:<addr>` (ZSET, `ZRANGE 0 -1`) | `lib/collected.ts`, timeline | +1 per collect | Med-High for heavy collectors |
| `hidden-moments`/`hidden-collections`/`hidden-users` | `lib/hidden*.ts` | +1 per hide | Med (memoized 5 min); read on most feeds |
| `kismetart:featured` (ZSET) | `app/api/featured/route.ts` | +1 per curate | Med (admin-bounded; **now trimmed** to `MAX_FEATURED=1000` on write, `lib/redis.ts`) |

`memoize()` (`lib/memoCache.ts`, process-local TTL + single-flight) cuts read
**frequency** but not **payload size**, and is **per-pod**. **Fix → B3** (bound the
reads; move list-shaped truth off Redis).

### 4b. Correctly bounded (good — no action)

- **`kismetart:trending`** capped at 10k on every collect via
  `ZREMRANGEBYRANK(TRENDING_KEY, 0, -10001)` in the collect MULTI
  (`app/api/collect/route.ts:256`); feed reads a bounded `ZRANGE 0 9999`.
- **`kismetart:trending-latest`** rides the same collect MULTI with the same 10k trim.
- **`kismetart:sale-ends`** written through via `after()` (`lib/saleEnds.ts`):
  per-pod seen-cache, throttled sweeps, bounded `ZRANGE BYSCORE now→+inf LIMIT 0 10000`.
- Notifications capped 200; pass-validity flags 30–90-day TTLs; rate-limit/nonce/session/
  quota/leader-lock keys all TTL'd; showcase 4/category; airdrops 500/sender.

### 4c. Per-request command volume

Each authenticated request issues a **handful** of Redis commands (1 rate-limit `EVAL`
+ 1 session `GET` + the route's reads/writes) — **not** "40 commands/request" (40 is
the count of distinct rate-limited endpoints). The big-payload `SMEMBERS`/`MGET`/`ZRANGE`
reads in §4a are what move the Upstash **bandwidth** needle.

### 4d. Large values in Redis  ⬜

`kismetart:moment-content:<addr>:<tokenId>` stores writing-moment bodies up to **10 MB**
(`lib/mint-proxy.ts:27`, `MAX_TOKEN_CONTENT_BYTES`). Consider Arweave/object storage for
the body with Redis holding only a pointer.

## 5. Compute & infrastructure

**Build is memory-constrained** — `next.config.mjs` runs SWC `cpus:1` +
`webpackMemoryOptimizations`, `NODE_OPTIONS=--max-old-space-size=4096`, and defers
typecheck/lint to `npm run check` (now enforced in CI, §7). Runtime:
`output:'standalone'`, `node server.js` (graceful SIGTERM), non-root.

- **`/api/img`** streams up to **2 GB** of media through Node (`app/api/img/route.ts`),
  SSRF-guarded to `ar://`+`ipfs://`, 1-year immutable cache header, no per-IP count
  limit (deliberately — see §9). Without a CDN, every view streams through the one box.
  **Highest-leverage infra change → 🛠 `OPS_RUNBOOK.md` (CDN).**
- **`/api/transcode-gif`** is ffmpeg with an in-process semaphore of 1
  (`route.ts`, `MAX_CONCURRENT=1`) + `maxDuration=300` — globally serialized on one
  instance. Needs an off-box worker to scale.
- Background sweeps run under a Redis leader lock (`lib/backgroundTasks.ts`) — correct
  for multi-pod.

**Readiness coupling — ✅ resolved.** `/api/readiness` no longer hard-gates on Base RPC.
RPC is checked but reported as `degraded` only; readiness flips to 503 **only** when
Redis fails `READINESS_FAILURE_THRESHOLD=3` times consecutively
(`app/api/readiness/route.ts:110,118-126`). An RPC blip can no longer dark the site.

**What still degrades if you add pods today:** process-local `memoize` caches (≤5-min
cross-pod staleness), and the Next fetch/ISR/image cache being **per-pod on local disk**.
Horizontal scale wants a shared cache handler (§B4). Sessions are Redis-backed, so
requests are already stateless.

## 6. External APIs & dependencies

### 6a. inprocess.world — **the** dependency  🔶
- **Reads:** `/timeline` (fanned out, §2), `/moment`, `/collection`, `/collections`,
  `/payments`, smart-wallet resolution.
- **Writes/relay:** `/moment/create`, `/moment/create/writing`, `/airdrop`,
  `/distribute` — sponsored userOps under the shared `INPROCESS_API_KEY`.
- **Timeouts — ✅ mostly resolved.** Mint relay 60 s, distribute 45 s, and the
  previously-unbounded `/api/moment`, `/api/payments`, `/api/moment/comments`, and
  timeline fan-out now all carry `AbortSignal.timeout(8s)` (`lib/inprocess.ts:431`
  default; per-route on `moment`/`payments`/`comments`). **The per-card `/api/moment`
  price fetch storm is ✅ resolved** — `MomentCard` reads `moment.saleConfig` or the
  dwell-gated, deduped `useMomentSale` hook that coalesces visible cards into one
  batched `/api/moments` call (`app/api/moments/route.ts`).
- **Still open:** a **circuit breaker + bulkhead** around the single upstream (§B10),
  and contractual throughput/SLA + an API-key spend ceiling.

### 6b. Arweave / ArDrive Turbo — the spend backstop  ⬜
- `/api/sign` signs 48-byte deep-hash chunks so media streams **client → Turbo**; the
  server never sees the bytes and cannot meter them. Hard ceiling on drain = the
  **funding wallet balance**. Controls: IP rate limit (10/min), per-address `sign-calls`
  quota (200/day), operational balance capping.
- `/api/upload` (JSON metadata, 50 MB cap, 500 MB/day/address) is byte-metered.
- **Fix → B7/A4:** Turbo `shareCredits` for a protocol-enforced per-identity ceiling +
  a bounded funder float with balance alerts; a global daily sign ceiling.

### 6c. Base + Ethereum RPC (viem/wagmi)  🔶
- **✅ Server-side RPC is now server-only** — `rpc.ts:22` prefers `BASE_RPC_URL`,
  falling back to `NEXT_PUBLIC_BASE_RPC_URL` only if unset. Client RPC still uses the
  public var (unavoidable for wallet reads); domain-restrict that key.
- Multicall batching on (`batch:true`, `wagmi.ts`). **Still open:** no `fallback()`
  transport / `rank` for provider failover (§B6).

### 6d. Farcaster  ⬜
- `api.farcaster.xyz` for primary-address + profile, cached **1 h (hit) / 5 min (miss)**
  in Redis (`lib/farcasterAuth.ts`, `lib/farcasterProfile.ts`) — on the per-request path
  for Mini App users on a cache miss. Hub used only for webhook signature verify.
  Quick-Auth JWT verification validates against the issuer's **remote JWKS**
  (`auth.farcaster.xyz/.well-known/jwks.json`), fetched once and cached in-process — the
  runtime needs egress there and reuses one long-lived client (**✅ the "verifies
  offline" comment has been corrected**, A1).
- Native push POSTs are SSRF-guarded, 10 s timeout, ≤100 tokens/batch, idempotent,
  GC-invalid-tokens — well built.
- **Fix → B9:** move primary-address/FID resolution to **Neynar bulk** for reliability +
  quota; parse `failedTokens`; retry `rateLimitedTokens`.

### 6e. Alchemy webhook (inbound)  ⬜
`/api/webhooks/pass-transfer` — HMAC-SHA256 timing-safe verify on the raw body,
idempotent on `txHash`+`logIndex`. **Gap (B8):** no `alchemy_getAssetTransfers`
reconciliation backstop; a dropped webhook lags gate convergence.

### 6f. WalletConnect / RainbowKit / IPFS+AR.IO gateways
WalletConnect needs `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`. Gateway pool is **raced**
server-side in `/api/img` and on the client with 404 fallthrough — resilient; content
is content-addressed → 1-year immutable caching. (Gateway pool is down to arweave.net
alone — re-add a verified AR.IO gateway; tracked in `VIDEO_PLAYBACK_RCA.md`.)

## 7. Dependencies & supply chain  ✅ (CI) / 🔶 (high-sev tail)

**CI now exists** — `.github/workflows/ci.yml` runs `npm ci` → build → `npm run check`
(typecheck + lint + resource-hint + bundle-size) → `npm audit` (blocks **critical**;
`high` is `continue-on-error` pending the transitive triage) — plus
`.github/dependabot.yml` (grouped weekly updates, majors split for
turbo-sdk/ws/undici). The audit's original "there is no CI / no dependency scanning" is
**resolved.**

**`npm audit` today: 65 vulnerabilities — 0 critical, 7 high, 40 moderate, 18 low**
(down from the first audit's 67 / 3 critical / 8 high). The **critical `arbundles`
chain is cleared** via root `overrides` (§B13). The remaining 7 **high** live in the
wallet stack (`ws` via wagmi→walletconnect→reown) and the Turbo/CDP transitive tree,
not app code — none reachable on the upload path (§B13). **Open:** land the `ws` /
turbo-sdk major bumps so CI can flip `audit-level=high` to blocking.

**Version posture (good):** Next 15.5, React 19, Node 22 LTS, viem 2 / wagmi 2 — all
current; engines pin `node >=22.11`.

## 8. Client-side scale (UX & bandwidth)

- **Bundles are heavy:** shared `/layout` baseline ~**2.0 MB** JS; per-page ~1.1–1.27 MB
  (`bundle-baseline.json`) — the web3 stack + ffmpeg.wasm. ffmpeg-core is copied to
  `public/` and loaded on demand; FC SDK is dynamically imported. Keep pushing heavy
  deps behind dynamic imports.
- **✅ `durationCache` is now `LRUCache(512)`** (`lib/media/durationCache.ts:16`) — the
  previously-unbounded `Map` is fixed. Other client caches are already bounded LRUs
  (`lib/lruCache.ts`).

## 9. Security / abuse controls (already strong; scale notes)

Layered: intent-signature verification on mint/write (`lib/intentAuth.ts`), httpOnly
session + FC JWT fallback, per-identity quotas (`lib/userQuota.ts`), IP rate limits on
~40 endpoints, action + pass blacklists, gate/pause kill switch, on-chain verification
before crediting collects, idempotency keys, SSRF guards on the proxy + push URLs,
`__Host-` cookie prefix, timing-safe webhook HMAC.

Scale-relevant notes:
- **✅ `/api/listings POST` now rate-limited** — per-IP 20/60 + per-seller 5/60
  (`listings/route.ts:364,464`). **`/api/img` deliberately has no request-count limit**:
  `<video>` streams through it via Range and the Mini App audience is largely behind
  carrier-grade NAT, so a per-IP cap would 429 legitimate viewers. Its controls are the
  2 GB per-request size cap + a CDN (🛠 `OPS_RUNBOOK.md`).
- Rate limits and quotas **fail open** — correct for availability, but a Redis outage
  removes all spend/abuse ceilings simultaneously. Pair with the wallet-balance backstop
  + Upstash alerting.
- **No global ceilings** on platform-paid resources (gas via inprocess key, Arweave
  spend). Add aggregate daily caps as a circuit breaker.

---

# Part II — Per-issue remediation (verdict + fix + citation + status)

_Every recommendation below was researched against primary sources (official docs, or,
where doc sites returned HTTP 403 to automated fetch, the canonical GitHub upstreams the
sites are generated from — `redis/redis-doc`, `upstash/docs`, `wevm/viem`,
`farcasterxyz/miniapps`, `ardriveapp/pub-docs`). Where a number lives only in a
JS-rendered page it is flagged needs-live-confirmation._

### B1. Feed — replace fan-out-on-read · **Confirmed, refine to hybrid** · ⬜
Fan-out-on-read is the model the literature calls too slow at scale; the production
answer is a **hybrid** — push for normal creators, **pull-at-read for high-fan-out
("blue-chip") creators**, merged at read time (Instagram precomputes normal feeds, not
celebrity ones). Storage primitive: capped Redis **ZSETs** keyed by scope, score =
`created_at`, capped on every write with `ZREMRANGEBYRANK key 0 -(maxlen+1)`.
**Paginate by score cursor, not offset** (offset is O(N) on deep pages); add a
tiebreaker for equal `created_at` (block-timestamp collisions) so the cursor is strictly
monotonic. If inprocess can expose a true global cross-collection **cursor** timeline,
prefer it — it removes the in-memory merge entirely.
([ByteByteGo News Feed](https://bytebytego.com/courses/system-design-interview/design-a-news-feed-system), [High Scalability — Instagram](https://highscalability.com/designing-instagram/), [Redis sorted sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/), [ZRANGE](https://redis.io/docs/latest/commands/zrange/), [Azure Materialized View](https://learn.microsoft.com/en-us/azure/architecture/patterns/materialized-view))

### B2. Notifications — move off the request path · **Confirmed, queue + hybrid** · ⬜
**Upstash QStash** fits this stack — at-least-once delivery, retries + DLQ, `/v2/batch`
to collapse the fan-out, Flow Control to throttle the push provider. `after()` is only an
*enqueue* helper (no durability, bounded by route `maxDuration`). Make the worker
**idempotent** (at-least-once ⇒ double delivery). For high-follower creators, batch
aggressively or move to a pull "new since last seen" rather than push-per-follower.
([QStash background jobs](https://upstash.com/docs/qstash/features/background-jobs), [batch](https://upstash.com/docs/qstash/features/batch), [flow control](https://upstash.com/docs/qstash/features/flowcontrol), [Azure Queue-Based Load Leveling](https://learn.microsoft.com/en-us/azure/architecture/patterns/queue-based-load-leveling))

### B3. Redis as sole datastore · **Confirmed — Postgres SoR + Redis cache/counters/locks** · ⬜
Upstash hard limits (current): **10 MB** max request, **100 MB** max value, **32 KB** max
hash field, **per-command** billing, ~10k req/s lower tiers; over-quota returns hard
errors. Per Redis's own docs, `SMEMBERS`/`HGETALL`/`ZRANGE 0 -1`/`MGET` are **O(N)** and
"may block the server for several seconds" on big collections — fix with **SCAN-family
cursor iteration** (`SSCAN`/`HSCAN`/`ZSCAN`) or indexed pagination, and use **`SCARD`
(O(1))** for counts. Auto-pipelining (default-on) cuts round-trips but **not command
count** — a pipelined `SMEMBERS` of a huge set still blows the 10 MB cap. **Direction:**
Postgres = system of record for unbounded list-shaped data (collections registry,
follows, notifications, listings, collected history) with keyset pagination; Redis =
cache + counters + locks + rate-limiting.
([Upstash max-request-size](https://raw.githubusercontent.com/upstash/docs/main/redis/troubleshooting/max_request_size_exceeded.mdx), [Redis SCAN](https://redis.io/docs/latest/commands/scan/), ["Redis running slowly"](https://redis.io/blog/redis-running-slowly-heres-what-you-can-do-about-it/), [Upstash auto-pipeline](https://raw.githubusercontent.com/upstash/docs/main/redis/sdks/ts/pipelining/auto-pipeline.mdx))

### B4. Multi-pod Next.js caching · **Confirmed** · ⬜ (single-pod today)
Default ISR/Data Cache is **per-instance** (in-memory + local disk), not shared. The
documented multi-instance solution is a custom **`cacheHandler`** backed by Redis with
**`cacheMaxMemorySize:0`**; for Next 15 use **`@fortedigital/nextjs-cache-handler`** (the
older `@neshca/cache-handler` doesn't support 15). Wire **CDN purge on revalidation**
(HTML + RSC) — `revalidateTag`/`revalidatePath` invalidate only the Next server cache,
not the CDN (A7).
([Next self-hosting](https://nextjs.org/docs/app/guides/self-hosting), [cacheHandler](https://nextjs.org/docs/app/api-reference/config/next-config-js/incrementalCacheHandlerPath), [@fortedigital](https://github.com/fortedigital/nextjs-cache-handler), [CDN caching](https://nextjs.org/docs/app/guides/cdn-caching))

### B5. Image/media proxy `/api/img` · **Confirmed — CDN is the highest-leverage change** · 🛠
Content-addressed immutable media should be served with long immutable `Cache-Control`
and cached at the **edge**; unbounded media egress through one box is OWASP
**API4:2023 Unrestricted Resource Consumption** (a DoS *and* cost vector). A request-*count*
rate limit is the **wrong tool** here (Range streaming + carrier-NAT would 429 real
viewers) — keep the 2 GB per-request size cap + a CDN. The `ar://`+`ipfs://` allow-list +
no-redirect posture is the correct **SSRF** control. **The origin is already CDN-ready;
the Cloudflare configuration is the remaining step → `OPS_RUNBOOK.md`.**
([API4:2023](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/), [SSRF Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html))

### B6. RPC key exposure + resilience · **Confirmed, with refinements** · 🔶
**✅ Server-only key done** (`rpc.ts:22`). **✅ Readiness decoupled from RPC** (§5).
**Still open:** add a viem **`fallback`** transport for failover — note it is *failover,
not load-balancing*: list order matters, add **`rank:true`** to auto-promote the
healthiest, use **different providers/keys** per transport; viem deliberately does not
fail over on reverts (only 429/timeout/5xx). Keep `batch:true`.
([viem fallback](https://github.com/wevm/viem/blob/main/site/pages/docs/clients/transports/fallback.md), [SRE cascading failures](https://sre.google/sre-book/addressing-cascading-failures/))

### B7. Arweave / Turbo spend · **Confirmed + upgrade (A4)** · ⬜
No SDK-side byte metering exists, so app-level per-identity + **global daily** sign caps
are needed, **plus** Turbo `shareCredits` approvals (protocol-enforced per-identity
ceiling, spent via the `paidBy` the app already sets), **plus** a bounded funder float
with **balance alerts** (`payment.ardrive.io/v1/balance/...`). Frame as OWASP API4.
([Turbo credit-sharing](https://docs.ardrive.io/docs/turbo/credit-sharing.html))

### B8. Alchemy webhook reliability · **Confirmed (all three layers)** · 🔶
Delivery is at-least-once (≤5 retries, backoff), best-effort FIFO. The app already does
(1) **HMAC-verify the raw body** and (2) **idempotency** on `txHash`+`logIndex`. **Gap:**
(3) a **reconciliation backstop** via `alchemy_getAssetTransfers` over recent blocks
(paginate `pageKey`, prefer `latest` over the cached `indexed` tag).
([Alchemy retries](https://docs.alchemy.com/reference/how-to-implement-retries), [getAssetTransfers](https://docs.alchemy.com/reference/alchemy-getassettransfers))

### B9. Farcaster · **Confirmed, with A1 & A3** · ⬜
Notification caps verified: `notificationId` ≤128, `title` ≤32, `body` ≤128, `tokens`
≤100/request; limits 1/30s + 100/day per token; idempotency `(FID, notificationId)` over
24 h. **Handle the optional `failedTokens` field and retry `rateLimitedTokens`** (A3 —
still unparsed). `api.farcaster.xyz` has no published rate limits/SLA — move
primary-address/FID resolution to **Neynar bulk `/fc/primary-addresses` (≤100 FIDs)** with
single-flight coalescing; a reliability fix, not just quota. Quick-Auth correction → A1.
([notifications spec](https://miniapps.farcaster.xyz/docs/guides/notifications), [miniapp-core schema](https://github.com/farcasterxyz/miniapps/blob/main/packages/miniapp-core/src/schemas/notifications.ts), [Neynar user-by-address](https://docs.neynar.com/docs/fetching-farcaster-user-based-on-ethereum-address))

### B10. inprocess.world (the upstream) · **Confirmed — undocumented SPOF** · 🔶
No public API docs/limits/SLA; a Zora-on-Base indexer + sponsored-relay under a shared
key. Treat as a single point of failure: **Circuit Breaker + Bulkhead + Timeouts +
Cache-Aside**, and get throughput/rate-limit/SLA commitments in writing. **✅ Uniform
per-call `AbortSignal.timeout` added** to the calls that lacked one; **✅ per-card
`/api/moment` price fetches coalesced.** **Open:** the circuit breaker + bulkhead
isolation.
([Azure circuit-breaker](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker), [bulkhead](https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead), [SRE handling overload](https://sre.google/sre-book/handling-overload/))

### B11. Dependencies & CI · **Confirmed** · ✅ (CI shipped) / 🔶 (audit gate)
**✅ GitHub Actions CI exists** (least-priv `contents:read`, `npm ci`, build,
`npm run check`, patch-applied assert) + dependabot. **Open refinements:** flip
`npm audit` gate from `critical` to **`--audit-level=high`** once the transitive tree is
triaged (fix by **bumping the parent** package, `overrides` root-level only, verified by
`npm ci` + build — never blind `--force`); SHA-pin Actions; add a Node matrix; track
posture with OpenSSF Scorecard.
([npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit/), [npm overrides](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/), [OWASP A06](https://owasp.org/Top10/2021/A06_2021-Vulnerable_and_Outdated_Components/))

### B12. Retries / overload (cross-cutting) · **Add what's missing** · ⬜
Wherever the app retries upstream/Redis/RPC, use **finite attempts + truncated
exponential backoff *with jitter*** + a **server-wide retry budget**; stop when a circuit
is open; honor `Retry-After`. Un-jittered retries cause synchronized retry storms. Add
**the four golden signals** (latency/traffic/errors/saturation) + SLOs so remediation is
prioritized by data, not feel.
([SRE cascading failures](https://sre.google/sre-book/addressing-cascading-failures/), [Azure retry-storm antipattern](https://learn.microsoft.com/en-us/azure/architecture/antipatterns/retry-storm/), [SRE SLOs](https://sre.google/sre-book/service-level-objectives/))

### B13. Arweave/Turbo transitive CVE chain · **Fixed via root `overrides` (verified)** · ✅ / ⬜ (`/api/sign`)
The `@ardrive/turbo-sdk` audit findings are pulled in by Turbo's **unused** multi-chain
payment/signer features, not the upload path (the app signs ANS-104 items with the RSA
Arweave signer; Turbo's HTTP client is native `fetch` to fixed hosts). Per-finding
reachability was tarball-verified — `elliptic` (critical; only via EthereumSigner /
`@cosmjs`), `axios` (only `@cosmjs/tendermint-rpc`), `tmp` (arbundles disk helpers, not
the stream path), `undici` (only via `@permaweb/aoconnect`, unused) — **none reachable.**
**✅ Fixed** with root `overrides` (`package.json:63-68`): `elliptic ^6.6.1`,
`axios ^1.17.0`, `tmp ^0.2.7`, `undici ^6.24.0`; verified by `npm install` + `next build`
+ a runtime module-load. Result: the Arweave chain is cleared (**0 critical**); the
remaining high-sev tail is the wallet-stack `ws` copies (own pass).
**⬜ One real (non-dependency) gap:** `/api/sign` will sign *any* 48-byte hash for an
authenticated user, so the platform key can be coerced into signing a user-constructed
data item (billed to the platform wallet). The 48-byte length check blocks cross-protocol
oracle abuse but not this; today it's bounded operationally by per-user quota + a
deliberately small Turbo balance. Full fix = server reconstructs the data item from
approved fields rather than trusting a bare hash.
([elliptic advisory](https://github.com/advisories/GHSA-vjh7-7g9h-fjfh), [ANS-104](https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md), [npm overrides](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/))

---

# Part III — Corrections & upgrades the research produced

**Corrections (something was wrong):**
- **A1. ✅ Quick Auth is NOT offline** — `verifyJwt` validates against the remote JWKS
   (`auth.farcaster.xyz/.well-known/jwks.json`), fetched once + cached in-process. The
   runtime needs egress there and must reuse one long-lived client; enforce `aud = your
   domain`. The misleading "verifies locally" comment has been corrected in code.
- **A2. The `created-mints` SMEMBERS hard-fails, not just slows** — Upstash's 10 MB
   max-request-size means the unbounded set throws once past ~200k members, breaking the
   Mints feed on every read until split. An availability cliff (⬜ B3), not just latency.
- **A3. ⬜ The Farcaster push response has a 4th field the code doesn't parse** —
   `failedTokens` (alongside successful/invalid/rateLimited); transient host failures are
   silently dropped. Also retry `rateLimitedTokens` with backoff (A3/B9).

**Upgrades (a stronger fix than first proposed):**
- **A4. ⬜ Arweave spend: Turbo `shareCredits`** — a protocol-enforced per-identity cap
   (`approvedAddress`, `approvedWincAmount`, `expiresBySeconds`), spent via the `paidBy`
   the app already sets. Converts "wallet balance is the only ceiling" into a per-identity
   one (B7).
- **A5. Feed/notifications: hybrid, not a straight swap** — a pure push just relocates the
   celebrity write-storm to mint-time; push for normal creators, pull-at-read for
   blue-chip (B1/B2).
- **A6. ✅ Transitive npm vulns fix at the *parent*, not the leaf** — root `overrides`
   verified by `npm ci` + build, never blind `--force` (B13).
- **A7. ⬜ `revalidateTag`/`revalidatePath` do not purge the CDN** — wire a CDN purge (HTML
   *and* RSC variants) into every on-demand revalidation (B4).

# Part IV — Methodology validation

The review structure (identify SPOFs → model load with data → failure-mode analysis →
prioritized remediation) matches the canonical method: AWS Well-Architected (blame-free,
data-driven RCA), Google SRE (error-budget/SLO prioritization + explicit failure-mode
reasoning).

| Finding | Validating principle | Framework's prescribed fix |
|---|---|---|
| Single Redis = SPOF | AWS Reliability *eliminate SPOFs*; 12-Factor *backing services* | HA/replication; Postgres SoR; swappable resources |
| In-process cache blocks multi-pod | 12-Factor *stateless/concurrency* | Externalize state; shared `cacheHandler`; N stateless pods |
| inprocess upstream can overload the app | SRE *cascading failures*; Azure *Circuit Breaker + Bulkhead* | Breaker, bulkhead-isolate, adaptive throttle, degrade |
| Fan-out feed/notifications | Azure *Queue-Based Load Leveling + Materialized View* | Queue + workers; precomputed hybrid feed |
| Readiness hard-gated on RPC → cascade | SRE *overload causes health-check failures* | Decouple health from serving capacity (**✅ done**) |
| Unbounded retries risk a storm | SRE *retry budget*; Azure *Retry Storm antipattern* | Finite retries + backoff **+ jitter** + breaker |
| Unbounded paid consumption (`/api/img`, gas, Arweave, RPC) | OWASP **API4:2023** | Rate-limit; max sizes; per-identity + global caps; budget alerts |
| ar://+ipfs:// fetch proxy | OWASP **A10 / API7 SSRF** | Allow-list schema/destination; no redirects (**✅ kept**) |
| npm vulns | OWASP **A06** | SCA in CI (**✅**); bump parents; remove unused; patch cadence |
| No SLOs / observability | SRE *four golden signals*; AWS *observability* | Instrument golden signals; SLOs to rank fixes |

Two cautions the frameworks stress: **(1)** overload-induced **health-check cascades**
(the readiness finding — now resolved); **(2)** **unbounded cost from paid dependencies**
(OWASP API4) is simultaneously a security *and* a cost finding — the Arweave / sponsored-gas
/ RPC / media-egress cluster.

# Part V — Roadmap (status-tracked)

**Now (days) — cheap, high-leverage, no architecture change:**
1. ✅ Server-only RPC key · ✅ readiness decoupled · ✅ CI + dependabot · ✅ listings
   rate limit · ✅ per-call timeouts · ✅ per-card fetch coalesced · ✅ `durationCache`
   LRU · ✅ arbundles overrides. **Remaining:** 🛠 **front `/api/img` with a CDN**
   (`OPS_RUNBOOK.md`); land the `ws`/turbo-sdk high-sev bumps and flip the audit gate to
   `high`; add a viem `fallback` provider; parse `failedTokens`; balance alerts.

**Next (weeks) — relieve the cliffs without re-platforming:**
2. Bound the big reads (`created-mints` SCAN/scope-filter; paginate
   `collected`/`listings`/`featured`); move primary-address resolution to Neynar bulk +
   single-flight (B9); **notification fan-out → QStash** (batch + flow-control +
   idempotent worker, B2); shared Redis `cacheHandler` if/when >1 pod (B4) with CDN purge
   on revalidation (A7); circuit breaker on inprocess (B10); reconciliation backstop on
   the Alchemy webhook (B8).

**Architectural (the real scale unlock):**
3. **Hybrid materialized feed** (capped ZSETs + score-cursor pagination; push normal /
   pull blue-chip) or an upstream global cursor timeline (B1) — removes the O(collections)
   fan-out.
4. **Postgres as system-of-record** for list-shaped state; demote Redis to
   cache/counters/locks (B3) — the change that unblocks many stateless pods. Move
   transcode off-box (competing-consumer workers).

---

_Sourcing caveat: several official doc hosts (nextjs.org, redis.io, Upstash, Alchemy,
Farcaster, AWS/Azure/OWASP) returned HTTP 403 to automated fetching; those claims were
verified against the canonical GitHub sources the sites are generated from. Exact figures
that live only in JS-rendered pages (Upstash per-plan connection counts; SRE's
"60 retries/min") should be re-confirmed verbatim before being quoted in a formal
deliverable._
