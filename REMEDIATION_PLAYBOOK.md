# Kismet — Remediation Playbook (researched & source-verified)

_Companion to `SCALING_AUDIT.md`. For every finding: what the authoritative
documentation actually says, whether it **confirms** or **corrects** the fix the
audit proposed, the concrete change, and the citation. Closes with a validation
of the audit **methodology** against established review frameworks._

**How this was verified.** Each issue cluster was researched against primary
sources — official docs and, where doc sites blocked automated fetches (HTTP 403
was common: nextjs.org, redis.io, upstash docs, alchemy, farcaster, AWS/Azure/
OWASP), the **canonical upstream that those sites are generated from** (the
`redis/redis-doc` `commands.json`, `upstash/docs` `.mdx`, `wevm/viem` source,
`farcasterxyz/miniapps` Zod schemas, `ardriveapp/pub-docs`). Where a number lives
only in a JS-rendered page it's flagged as needs-live-confirmation rather than
guessed.

**Net result:** every major recommendation in the audit is **confirmed** by
authoritative sources. Research produced **four upgrades** (a stronger fix than
proposed) and **three corrections** (something the audit or the codebase got
wrong). Those are collected first.

---

## A. Corrections & upgrades the research produced

### Corrections (something was wrong)
1. **Quick Auth is NOT offline.** The audit (and a code comment in
   `lib/farcasterAuth.ts`) said Quick-Auth JWTs verify "locally, no network."
   `@farcaster/quick-auth`'s `verifyJwt` delegates to `verifyJwtWithJwks`, which
   verifies the signature against the issuer's **remote JWKS** via jose's
   `createRemoteJWKSet(https://auth.farcaster.xyz/.well-known/jwks.json)`. Keys are
   fetched once and cached in-process, so steady-state is local CPU — but **cold
   starts and key rotations make a network call.** Implications: the runtime needs
   **egress to `auth.farcaster.xyz`**, you must **reuse one long-lived client** (the
   cache is module-scoped per URL), and add a small resiliency margin for issuer
   unreachability on cold start. Enforce `aud = your domain`; `sub` is the FID.
   ([quick-auth `verifyJwtWithJwks.ts`](https://github.com/farcasterxyz/quick-auth/blob/main/quick-auth/src/actions/verifyJwtWithJwks.ts), [Quick Auth SDK docs](https://miniapps.farcaster.xyz/docs/sdk/quick-auth))
2. **The `created-mints` SMEMBERS isn't "slow at scale" — it _hard-fails_.** Upstash
   documents a **10 MB max request size**, and explicitly: a list/set "can exceed
   the max request size limit… if you try to load all elements… in a single request
   then it can throw the max-request-size-limit exception." So the unbounded
   `SMEMBERS kismetart:created-mints` throws (HTTP error) once the set passes ~10 MB
   (~200k `addr:tokenId` members), breaking the Mints feed on every request until the
   key is split — an availability cliff, not just latency.
   ([Upstash max-request-size](https://raw.githubusercontent.com/upstash/docs/main/redis/troubleshooting/max_request_size_exceeded.mdx))
3. **The Farcaster push response has a 4th field the code doesn't parse.** The
   canonical `sendNotificationResponseSchema` includes an optional **`failedTokens`**
   alongside `successfulTokens`/`invalidTokens`/`rateLimitedTokens`. The handler
   (`lib/farcasterNotifications.ts`) only reads three, so transient host failures are
   silently dropped. Also: `rateLimitedTokens` should be **retried with backoff**, not
   just left (the host enforces 1/30s per token).
   ([miniapp-core notifications schema](https://github.com/farcasterxyz/miniapps/blob/main/packages/miniapp-core/src/schemas/notifications.ts))

### Upgrades (a stronger fix than the audit proposed)
4. **Arweave spend: use Turbo's native `shareCredits` approvals** instead of only
   app-level caps + a bounded wallet. Turbo has no server-side byte metering, so the
   audit was right that the wallet balance is the only hard ceiling — but Turbo
   provides a **protocol-enforced per-identity cap**: `shareCredits({ approvedAddress,
   approvedWincAmount, expiresBySeconds })`, spent via `paidBy` (which the app already
   sets). Turbo refuses spend beyond the approved winc. This converts "balance is the
   only ceiling" into a per-identity, protocol-enforced ceiling.
   ([Turbo SDK — credit sharing](https://github.com/ardriveapp/pub-docs/blob/production/docs/src/docs/turbo/turbo-sdk/index.md), [credit-sharing](https://docs.ardrive.io/docs/turbo/credit-sharing.html))
5. **Feed/notifications: the correct design is a _hybrid_, not a straight swap.** A
   pure fan-out-on-write (push) just relocates the celebrity write-storm from feed-read
   to mint-time. Push for normal creators; **pull-at-read for high-fan-out
   collections/creators** (the "blue-chip" tier), merged at read time.
   ([ByteByteGo — News Feed](https://bytebytego.com/courses/system-design-interview/design-a-news-feed-system), [High Scalability — Instagram](https://highscalability.com/designing-instagram/))
6. **Transitive npm vulns usually fix at the _parent_, not the leaf.** A hand-written
   root `override` can pin the vulnerable leaf, but the real fix is often bumping the
   parent that depends on it — exactly the turbo-sdk→arbundles case. Verify any bump
   with `npm ci` + build rather than a blind `--force`.
   ([npm overrides](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/))
7. **`revalidateTag`/`revalidatePath` do not purge the CDN.** They invalidate the
   Next server cache only; a CDN in front keeps serving its copy until `s-maxage`
   expires. Wire a **CDN purge (HTML _and_ RSC variants)** into every on-demand
   revalidation. ([Next.js — CDN caching](https://nextjs.org/docs/app/guides/cdn-caching))

---

## B. Per-issue remediation (confirm/correct + concrete fix + citation)

### B1. Feed — replace fan-out-on-read  ·  Verdict: **CONFIRMED, refine to hybrid**
- **Guidance:** Fan-out-on-read ("assemble per-source timelines on every read, merge,
  sort, paginate") is the model the literature says is too slow at scale; the
  production answer is **hybrid push/pull selected by follower count** (~10k is the
  cited starting heuristic — treat as a tunable). Instagram precomputes feeds for
  normal users and does *not* precompute for celebrity accounts, fetching theirs at
  read time and merging.
  ([ByteByteGo](https://bytebytego.com/courses/system-design-interview/design-a-news-feed-system), [High Scalability](https://highscalability.com/designing-instagram/), [System Design School](https://systemdesignschool.io/problems/twitter/solution))
- **Storage primitive (confirmed):** capped Redis **ZSETs** keyed by scope, score =
  `created_at`, written on mint. Redis names "social-network timelines" as the model
  ZSET use case. **Cap on every write** with `ZREMRANGEBYRANK key 0 -(maxlen+1)`.
  ([Redis — sorted sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/), [ZREMRANGEBYRANK](https://redis.io/docs/latest/commands/zremrangebyrank/))
- **Pagination (correction to the naive approach):** **paginate by score cursor, not
  offset** — offset pagination on a ZSET is O(N) on deep pages. Use `ZRANGE … REV
  BYSCORE LIMIT` / `ZREVRANGEBYSCORE` passing the last-seen score as the cursor. Add a
  **tiebreaker** for equal `created_at` (NFT mints collide on block timestamps —
  encode a monotonic sequence into the score's fractional part or use lexical member
  order) so the cursor is strictly monotonic.
  ([Redis — ZRANGE](https://redis.io/docs/latest/commands/zrange/), [ZREVRANGEBYSCORE](https://redis.io/docs/latest/commands/zrevrangebyscore/))
- **Best option if available:** if inprocess exposes a true **global cross-collection
  timeline with cursor pagination**, prefer it — it removes the in-memory merge
  entirely. Verify it's cursor- (not offset-) based first.
- **Framework backing:** Azure **Materialized View** + **Cache-Aside**; AWS Perf
  *mechanical sympathy* (match datastore to access pattern).
  ([materialized-view](https://learn.microsoft.com/en-us/azure/architecture/patterns/materialized-view), [cache-aside](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside))

### B2. Notifications — move off the request path  ·  Verdict: **CONFIRMED, use a queue + hybrid**
- **Tooling:** **Upstash QStash** is the right fit for this serverless-ish stack —
  at-least-once delivery, retries + DLQ, **`/v2/batch`** to collapse the fan-out, and
  **Flow Control** to throttle the push provider. `after()` is only an *enqueue*
  helper (no durability, bounded by route `maxDuration`; stable in **Next 15.1+**).
  **BullMQ** needs a persistent worker host you don't currently run.
  ([QStash background jobs](https://upstash.com/docs/qstash/features/background-jobs), [batch](https://upstash.com/docs/qstash/features/batch), [flow control](https://upstash.com/docs/qstash/features/flowcontrol), [Next.js after()](https://nextjs.org/docs/app/api-reference/functions/after), [BullMQ workers](https://docs.bullmq.io/guide/workers))
- **Make the worker idempotent** (at-least-once ⇒ double delivery).
- **Hybrid again:** for high-follower creators, don't push per-follower even through a
  queue — batch aggressively or move to a pull/poll "new since last seen."
- **Framework backing:** Azure **Queue-Based Load Leveling** + **Competing Consumers**;
  12-Factor **Concurrency** (web vs worker process types).
  ([QBLL](https://learn.microsoft.com/en-us/azure/architecture/patterns/queue-based-load-leveling), [competing-consumers](https://learn.microsoft.com/en-us/azure/architecture/patterns/competing-consumers), [12factor VIII](https://12factor.net/concurrency))

### B3. Redis as sole datastore  ·  Verdict: **CONFIRMED — Postgres SoR + Redis cache/counters/locks**
- **Hard limits (Upstash, current):** **10 MB** max request, **100 MB** max value,
  **32 KB** max hash field, **per-command** billing (reads = writes), **200 GB/mo**
  bandwidth free then $0.03/GB, ~10k req/s lower tiers. Over-quota returns hard errors
  (`ERR max requests limit exceeded`, `…daily…`). Free tier is **unreplicated** and
  eviction/quota can drop data.
  ([Upstash pricing](https://upstash.com/docs/redis/overall/pricing), [max-request-size](https://raw.githubusercontent.com/upstash/docs/main/redis/troubleshooting/max_request_size_exceeded.mdx), [durability](https://raw.githubusercontent.com/upstash/docs/main/redis/features/durability.mdx))
- **The anti-pattern, per Redis's own docs:** `SMEMBERS`/`HGETALL`/`ZRANGE 0 -1`/`MGET`
  are **O(N)** and "may block the server for… several seconds when called against big
  collections." Fix = **SCAN-family cursor iteration** (`SSCAN`/`HSCAN`/`ZSCAN`) *or*
  indexed pagination; use **`SCARD` (O(1))** for counts, never `SMEMBERS`+length.
  ([Redis SCAN](https://redis.io/docs/latest/commands/scan/), ["Redis Running Slowly?"](https://redis.io/blog/redis-running-slowly-heres-what-you-can-do-about-it/), [commands.json](https://raw.githubusercontent.com/redis/redis-doc/master/commands.json))
- **Pipelining helps but isn't the fix:** `@upstash/redis` auto-pipelining is now
  **default-on** (use `Promise.all`, don't `await` each command) — cuts round-trips but
  **not command count**, and a pipelined `SMEMBERS` of a huge set still blows the 10 MB
  cap. Not a substitute for moving list-shaped data out.
  ([Upstash auto-pipeline](https://raw.githubusercontent.com/upstash/docs/main/redis/sdks/ts/pipelining/auto-pipeline.mdx))
- **Direction:** **Postgres = system of record** for unbounded list-shaped data
  (collections registry, follows, notifications, listings, collected history) with
  indexed **keyset/seek pagination**, FKs, transactions; **Redis = cache + counters +
  locks + rate-limiting** (its purpose-built workloads). Redis's own docs benchmark
  durability *against* Postgres and frame the durable disk DB as the source of truth.
  ([Redis cache-vs-primary](https://redis.io/blog/redis-cache-vs-redis-primary-database-in-90-seconds/), [Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/))
- **Framework backing:** AWS Reliability *eliminate SPOFs / scale horizontally*; 12-Factor
  *backing services*. ([AWS reliability](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/workload-architecture.html), [12factor IV](https://12factor.net/backing-services))

### B4. Multi-pod Next.js caching  ·  Verdict: **CONFIRMED**
- Default ISR/Data Cache is **per-instance** (in-memory + local disk), "lost on restart,"
  not shared. The documented multi-instance solution is a custom **`cacheHandler`**
  backed by Redis, with **`cacheMaxMemorySize: 0`** to make the shared store
  authoritative. For **Next 15**, use **`@fortedigital/nextjs-cache-handler`** — the
  older `@neshca/cache-handler` does **not** support 15. Add **CDN purge on
  revalidation** (HTML + RSC), since `revalidateTag` doesn't touch the CDN.
  ([Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting), [cacheHandler](https://nextjs.org/docs/app/api-reference/config/next-config-js/incrementalCacheHandlerPath), [@fortedigital handler](https://github.com/fortedigital/nextjs-cache-handler), [CDN caching](https://nextjs.org/docs/app/guides/cdn-caching))
- Version notes: `minimumCacheTTL` default is now **14400 s (4 h)**; **`sharp` is
  auto-used in 15** (no manual install); **graceful SIGTERM shutdown is automatic** in
  current Next (drains in-flight + runs `after()` before exit) — your Dockerfile's
  exec-node-directly is still correct, but you don't need custom signal code just to
  drain; Next 15 already uncaches `fetch`/`GET` handlers by default.
  ([images config](https://nextjs.org/docs/app/api-reference/config/next-config-js/images), [Next 15 blog](https://nextjs.org/blog/next-15))

### B5. Image/media proxy `/api/img`  ·  Verdict: **CONFIRMED — CDN is the highest-leverage change**
- The built-in optimizer is per-instance/CPU-heavy with its own local disk cache;
  content-addressed immutable media should be served with long immutable `Cache-Control`
  and cached at the **edge** — the CDN is the control here (unbounded media egress
  through one box is OWASP **API4:2023 Unrestricted Resource Consumption**, a DoS *and*
  cost vector). A request-*count* rate limit is the **wrong tool**: `<video>` streams
  through this route via Range requests and the Mini App audience is largely behind
  carrier-grade NAT, so a per-IP cap would 429 legitimate viewers — keep the 2 GB
  per-request size cap + a CDN instead. The existing ar://+ipfs:// allow-list +
  no-redirect posture is the correct **SSRF** control (OWASP A10/API7).
  ([Next.js images](https://nextjs.org/docs/app/api-reference/config/next-config-js/images), [API4:2023](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/), [SSRF Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html))

### B6. RPC key exposure + resilience  ·  Verdict: **CONFIRMED, with refinements**
- Move the RPC URL to a **server-only** env var (not `NEXT_PUBLIC_*`, which inlines it
  into the client bundle); best, **proxy RPC through a server route** so the key never
  ships. Any key that must reach the client → **domain/origin allowlist** (Alchemy
  dashboard). Add a **`fallback`** transport for failover — but note viem `fallback` is
  *failover, not load-balancing*: list order matters, add **`rank: true`** to
  auto-promote the healthiest, and use **different providers/keys** per transport. viem
  deliberately does **not** fail over on reverts (no double-execution), only on
  429/timeout/5xx. Add **`batch: true`** for throughput.
  ([Alchemy getting started](https://docs.alchemy.com/alchemy/introduction/getting-started), [viem fallback](https://github.com/wevm/viem/blob/main/site/pages/docs/clients/transports/fallback.md), [viem http](https://github.com/wevm/viem/blob/main/site/pages/docs/clients/transports/http.md))
- **Decouple readiness from RPC.** `/api/readiness` hard-gating on Base
  `getBlockNumber()` means an RPC blip pulls every pod from the LB → site-wide outage.
  SRE explicitly warns overload/dependency failure shouldn't flip health checks and
  cascade. Make RPC a *degraded* signal, not a hard gate.
  ([SRE — Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/))

### B7. Arweave / Turbo spend  ·  Verdict: **CONFIRMED + upgrade (see A4)**
- No SDK-side byte metering exists, so app-level per-identity + **global daily** sign
  caps are necessary, **plus** Turbo `shareCredits` approvals for a protocol-enforced
  per-identity ceiling, **plus** a bounded funder float with **balance alerts**
  (`getBalance` / `payment.ardrive.io/v1/balance/...`). Frame as OWASP **API4** (paid
  third-party consumption = DoS + cost).
  ([Turbo SDK](https://github.com/ardriveapp/pub-docs/blob/production/docs/src/docs/turbo/turbo-sdk/index.md), [API4:2023](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/))

### B8. Alchemy webhook reliability  ·  Verdict: **CONFIRMED (all three layers)**
- Delivery is **at-least-once (≤5 retries, exponential backoff), best-effort FIFO**, so:
  (1) **HMAC-verify the _raw_ body** (constant-time compare) — verifying re-stringified
  JSON is a common bug; (2) **idempotency** on `txHash`+`logIndex` (Alchemy's
  idempotency guarantee covers only the management API, not delivery); (3) a
  **reconciliation backstop** via `alchemy_getAssetTransfers` over recent blocks
  (paginate `pageKey`, prefer `latest` over the cached `indexed` tag). The app already
  does (1) and (2); (3) is the gap.
  ([Alchemy retries](https://docs.alchemy.com/reference/how-to-implement-retries), [getAssetTransfers](https://docs.alchemy.com/reference/alchemy-getassettransfers))

### B9. Farcaster  ·  Verdict: **CONFIRMED, with corrections A1 & A3**
- Notification caps verified exactly: `notificationId` ≤128, `title` ≤32, `body` ≤128,
  `tokens` ≤100/request; limits **1/30s + 100/day per token**; idempotency
  `(FID, notificationId)` over **24 h** (reuse one id across batches). Handle the
  optional **`failedTokens`** field and **retry `rateLimitedTokens`**.
  ([notifications spec](https://miniapps.farcaster.xyz/docs/guides/notifications), [schema](https://github.com/farcasterxyz/miniapps/blob/main/packages/miniapp-core/src/schemas/notifications.ts))
- **`api.farcaster.xyz` has no published rate limits/SLA** — moving primary-address/FID
  resolution to **Neynar** (Farcaster's own bundled provider) is a *reliability* fix,
  not just quota. Use the **bulk `/fc/primary-addresses` (≤100 FIDs)** endpoint, add
  **single-flight** coalescing, lengthen TTLs, and keep the existing negative-cache on
  misses. ([Farcaster API ref](https://docs.farcaster.xyz/reference/farcaster/api), [Neynar user-by-address](https://docs.neynar.com/docs/fetching-farcaster-user-based-on-ethereum-address))
- Quick Auth correction → see **A1**.

### B10. inprocess.world (the upstream)  ·  Verdict: **CONFIRMED — undocumented SPOF**
- No public API docs/limits/SLA (`docs.inprocess.world` is gated); it's a Zora-on-Base
  indexer + sponsored-relay under a shared key. Treat as a single point of failure and
  apply **Circuit Breaker + Bulkhead + Timeouts + Cache-Aside**, and **get throughput /
  rate-limit / SLA commitments from the vendor in writing.** Add uniform per-call
  `AbortSignal.timeout` to the calls that currently lack one (`/api/moment`,
  `/api/payments`, `/api/moment/comments`, the timeline fan-out). Coalesce the per-card
  `/api/moment` price fetches.
  ([circuit-breaker](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker), [bulkhead](https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead), [SRE overload](https://sre.google/sre-book/handling-overload/))

### B11. Dependencies & CI  ·  Verdict: **CONFIRMED, sharper levers (see A6)**
- Gate CI on **`npm audit --audit-level=high`** (block the 3 critical / 8 high; report
  the moderate/low tail). Fix the transitive vulns by **bumping the parent** package
  (often the only fix); use **`overrides`** only root-level and prefer **nested/`$`-scoped**
  forms for the `elliptic`/`secp256k1`/`ethers` leaves, verified by `npm ci` + build;
  never blind `--force` (semver-major). Triage the 67 by **reachability/VEX** — not all
  are exploitable. Add GitHub Actions (least-priv `GITHUB_TOKEN: contents: read`,
  `npm ci`, Node matrix, `.next/cache` caching) + branch protection requiring the check
  + SHA-pinned Actions; track posture with **OpenSSF Scorecard**.
  ([npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit/), [overrides](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/), [OWASP A06](https://owasp.org/Top10/2021/A06_2021-Vulnerable_and_Outdated_Components/), [GH Actions Node](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs), [Scorecard](https://github.com/ossf/scorecard/blob/main/docs/checks.md))

### B12. Retries / overload (cross-cutting)  ·  Verdict: **add what's missing**
- Wherever the app retries an upstream/Redis/RPC call, use **finite attempts +
  truncated exponential backoff _with jitter_** and a **server-wide retry budget**;
  stop retrying when a circuit is open; honor `Retry-After`. Un-jittered retries cause
  synchronized "retry storms" that self-DoS the backend.
  ([SRE cascading failures](https://sre.google/sre-book/addressing-cascading-failures/), [Azure retry-storm antipattern](https://learn.microsoft.com/en-us/azure/architecture/antipatterns/retry-storm/))
- Add **the four golden signals** (latency/traffic/errors/saturation) and **SLOs +
  error budgets** so remediation is prioritized by data, not feel.
  ([SRE monitoring](https://sre.google/sre-book/monitoring-distributed-systems/), [SRE SLOs](https://sre.google/sre-book/service-level-objectives/))

---

## C. Methodology validation — the audit's conclusions hold up against the canonical frameworks

The review structure (identify SPOFs → model load with data → failure-mode analysis →
prioritized, constructive remediation) **matches the canonical method**: AWS frames a
Well-Architected review as a blame-free, data-driven, RCA-style conversation; Google SRE
adds error-budget/SLO prioritization and explicit failure-mode reasoning.
([AWS review process](https://docs.aws.amazon.com/wellarchitected/latest/framework/the-review-process.html), [SRE SLOs](https://sre.google/sre-book/service-level-objectives/))

| Audit finding | Validating principle(s) | Fix the framework prescribes |
|---|---|---|
| Single Redis = SPOF for all state | AWS Reliability *eliminate SPOFs / scale horizontally*; 12-Factor *backing services* | HA/replication; Postgres SoR; swappable attached resources |
| In-process memo/cache blocks multi-pod | 12-Factor *stateless processes / concurrency*; AWS *scale horizontally* | Externalize state; shared `cacheHandler`; N stateless pods |
| inprocess upstream can overload the app | SRE *cascading failures / handling overload*; Azure *Circuit Breaker + Bulkhead + Throttling* | Circuit breaker, bulkhead-isolate pool, adaptive throttle, degrade |
| Fan-out feed/notifications, no backpressure | Azure *Queue-Based Load Leveling + Competing Consumers + Materialized View* | Queue + workers; precomputed hybrid feed |
| Readiness hard-gates on Base RPC → cascade | SRE *overload causes health-check failures* | Decouple health from serving capacity; load-shed, don't evict |
| Unbounded retries risk a storm | SRE *retry budget*; Azure *Retry Storm antipattern* | Finite retries + backoff **+ jitter** + circuit breaker |
| `/api/img`, gas, Arweave, RPC = unbounded paid consumption | OWASP **API4:2023** | Rate-limit; max sizes; per-identity + global caps; budget alerts |
| ar://+ipfs:// fetch proxy | OWASP **A10 / API7 SSRF** | Allow-list schema/destination; no redirects (already done — keep it) |
| 67 npm vulns (3 crit / 8 high) | OWASP **A06 Vulnerable & Outdated Components** | SCA in CI; bump parents; remove unused; patch cadence |
| RPC key in client bundle | AWS Security *strong identity / no static creds*; 12-Factor *config* | Server-only key / proxy; rotate; domain-restrict if client-side |
| No caching pressure relief on hot reads | Azure *Cache-Aside + Materialized View*; AWS Perf *mechanical sympathy* | Cache-aside; precompute; right datastore per access pattern |
| No SLOs / observability | SRE *four golden signals + error budgets*; AWS OpEx *observability* | Instrument golden signals; SLOs to rank fixes |

Two cross-cutting cautions the frameworks stress and the audit should keep front-and-center:
**(1)** overload-induced **health-check cascades** (SRE) — the readiness-probe finding is
not minor; **(2)** **unbounded resource/cost from paid dependencies** (OWASP API4) is
simultaneously a security *and* a cost finding — which is exactly the Arweave / sponsored-gas
/ RPC / media-egress cluster.

---

## D. Consolidated, source-grounded roadmap

**Now (days):**
1. **CDN in front of `/api/img` + static/feed GETs** (immutable content → edge offload; the CDN — not a request-count limit — is the control for the Range-streaming `/api/img`); add a per-IP rate limit to `/api/listings POST`. ([Next CDN](https://nextjs.org/docs/app/guides/cdn-caching), [API4](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/))
2. **Server-only RPC key + viem `fallback` (rank, batch); decouple readiness from RPC** (degrade not gate). ([viem](https://github.com/wevm/viem/blob/main/site/pages/docs/clients/transports/fallback.md), [SRE](https://sre.google/sre-book/addressing-cascading-failures/))
3. **CI** (`npm run check` + `npm audit --audit-level=high` + build, least-priv token, branch protection); schedule the critical arbundles/turbo-sdk + axios/CDP upgrades. ([GH Actions](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs))
4. **Uniform per-call timeouts + circuit breaker** on inprocess; **Turbo `shareCredits`** approvals + balance alerts; fix Quick Auth client reuse + egress; parse `failedTokens`. ([Azure CB](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker), [Turbo](https://docs.ardrive.io/docs/turbo/credit-sharing.html))

**Next (weeks):**
5. Coalesce per-card `/api/moment` fetches; bound the big Redis reads (SCAN/SCARD/paginate); move primary-address resolution to **Neynar bulk** + single-flight.
6. **Notification fan-out → QStash** (batch + flow-control + idempotent worker); shared **Redis `cacheHandler`** (`@fortedigital`) if/when running >1 pod, with CDN purge on revalidation.

**Architectural:**
7. **Hybrid materialized feed** (capped ZSETs + score-cursor pagination, push for normal / pull for blue-chip) — or adopt an upstream global cursor timeline.
8. **Postgres as system-of-record** for list-shaped state, Redis demoted to cache/counters/locks — the change that unblocks many stateless pods. Move transcode off-box (competing-consumer workers).

---

## E. Sources (primary)

Feed/queues: [ByteByteGo News Feed](https://bytebytego.com/courses/system-design-interview/design-a-news-feed-system) · [High Scalability — Instagram](https://highscalability.com/designing-instagram/) · [Redis sorted sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/) · [QStash](https://upstash.com/docs/qstash/features/background-jobs) · [Next.js after()](https://nextjs.org/docs/app/api-reference/functions/after) · [BullMQ](https://docs.bullmq.io/guide/workers)
Redis/Upstash/DB: [Upstash pricing](https://upstash.com/docs/redis/overall/pricing) · [max-request-size](https://raw.githubusercontent.com/upstash/docs/main/redis/troubleshooting/max_request_size_exceeded.mdx) · [auto-pipeline](https://raw.githubusercontent.com/upstash/docs/main/redis/sdks/ts/pipelining/auto-pipeline.mdx) · [Redis SCAN](https://redis.io/docs/latest/commands/scan/) · [Redis "running slowly"](https://redis.io/blog/redis-running-slowly-heres-what-you-can-do-about-it/) · [Redis cache-vs-primary](https://redis.io/blog/redis-cache-vs-redis-primary-database-in-90-seconds/)
Next.js: [self-hosting](https://nextjs.org/docs/app/guides/self-hosting) · [cacheHandler](https://nextjs.org/docs/app/api-reference/config/next-config-js/incrementalCacheHandlerPath) · [CDN caching](https://nextjs.org/docs/app/guides/cdn-caching) · [@fortedigital handler](https://github.com/fortedigital/nextjs-cache-handler) · [Next 15](https://nextjs.org/blog/next-15)
Web3: [viem fallback](https://github.com/wevm/viem/blob/main/site/pages/docs/clients/transports/fallback.md) · [viem http](https://github.com/wevm/viem/blob/main/site/pages/docs/clients/transports/http.md) · [Alchemy retries](https://docs.alchemy.com/reference/how-to-implement-retries) · [getAssetTransfers](https://docs.alchemy.com/reference/alchemy-getassettransfers) · [Turbo SDK](https://github.com/ardriveapp/pub-docs/blob/production/docs/src/docs/turbo/turbo-sdk/index.md) · [Turbo credit-sharing](https://docs.ardrive.io/docs/turbo/credit-sharing.html)
Farcaster: [notifications spec](https://miniapps.farcaster.xyz/docs/guides/notifications) · [miniapp-core schema](https://github.com/farcasterxyz/miniapps/blob/main/packages/miniapp-core/src/schemas/notifications.ts) · [quick-auth verifyJwtWithJwks](https://github.com/farcasterxyz/quick-auth/blob/main/quick-auth/src/actions/verifyJwtWithJwks.ts) · [Farcaster API ref](https://docs.farcaster.xyz/reference/farcaster/api) · [Neynar](https://docs.neynar.com/docs/fetching-farcaster-user-based-on-ethereum-address)
Supply chain/CI: [npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit/) · [npm overrides](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/) · [GH Actions Node](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs) · [OpenSSF Scorecard](https://github.com/ossf/scorecard/blob/main/docs/checks.md)
Frameworks: [AWS Well-Architected Reliability](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/design-principles.html) · [AWS review process](https://docs.aws.amazon.com/wellarchitected/latest/framework/the-review-process.html) · [SRE cascading failures](https://sre.google/sre-book/addressing-cascading-failures/) · [SRE handling overload](https://sre.google/sre-book/handling-overload/) · [SRE monitoring](https://sre.google/sre-book/monitoring-distributed-systems/) · [Azure patterns](https://learn.microsoft.com/en-us/azure/architecture/patterns/) · [Azure retry-storm](https://learn.microsoft.com/en-us/azure/architecture/antipatterns/retry-storm/) · [12-Factor](https://12factor.net/) · [OWASP Top 10 2021](https://owasp.org/Top10/2021/) · [OWASP API Top 10 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/) · [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/) · [OWASP WSTG](https://owasp.org/www-project-web-security-testing-guide/)

_Sourcing caveat: several official doc hosts (nextjs.org, redis.io, Upstash, Alchemy,
Farcaster, AWS/Azure/OWASP) returned HTTP 403 to automated fetching; those claims were
verified against the canonical GitHub sources the sites are generated from, or via
authoritative search indexing of the same pages. Exact figures flagged in the audit
(Upstash per-plan connection counts; SRE's "60 retries/min"/"3 attempts") should be
re-confirmed verbatim from the live pages before being quoted in a formal deliverable._
