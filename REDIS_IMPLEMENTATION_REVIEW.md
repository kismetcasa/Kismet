# Kismet — Redis Implementation Review & Target Design

_A complete catalog of every Redis read and write in the codebase — every key family,
every command, every caller with `file:line` — followed by a workload characterization
and researched options for the most optimized design given Kismet's specific
constraints. Produced 2026-07-11 by a five-agent exhaustive sweep of all 57
Redis-importing modules (~325 direct call sites), cross-checked against
`SCALING.md`, `STACK_OVERVIEW.md`, and `OPS_RUNBOOK.md`._

> **Companion docs.** `STACK_OVERVIEW.md` (component map), `SCALING.md` (scale
> cliffs + remediation status), `OPS_RUNBOOK.md` (ops). This document goes one
> level deeper on Redis specifically: the full keyspace, the per-request command
> economics, the durability/latency requirements each keyspace actually has, and
> a target design. Where this document contradicts an older doc, this one is
> current (corrections are flagged inline, §3.6).

---

## 0. TL;DR

**Inventory:** ~108 distinct key families across 10 domains; ~30 distinct Redis
commands used; 10 Lua scripts and ~12 MULTI transaction sites; 4 caching tiers above Redis;
2 failure-policy contracts (plus deliberate fail-open/fail-closed asymmetries in
gates and quotas). Full inventory in Part II.

**The five load-bearing facts for the design:**

1. **The workload is GET-dominated and latency-bound, not cost-bound.** Session
   validation (1 GET/authed request, uncached) + the notification badge poll
   (2 GETs/120s/visible tab) + the rate-limit EVAL (every request, ~54 routes)
   dominate command volume (`OPS_RUNBOOK.md:82`). **Confirmed from the Upstash
   console (2026-07-11): 579K commands this month — 500,124 reads vs 78,746
   writes (86% reads) — costing $1.16; total data size 336KB; bandwidth
   227MB of the free 200GB.** The Usage charts put the steady run rate at
   ~50–70K commands/day (≈1.5–2M/mo pace ≈ $3–4/mo) and ~20MB/day bandwidth.
   The database is PAYG, Global type, primary in AWS `us-east-1`, and also
   exposes the native Redis protocol (port 6379/TLS). **Measured 2026-07-11
   from inside the app container (Coolify web terminal, 10 timed PINGs):
   steady-state RTT ≈ 4.4ms median (3.7–7.9ms); cold first-connection 162ms.**
   The box is effectively in the same Virginia metro as `us-east-1` — the
   cross-cloud latency the runbook feared is NOT material at steady state
   (the cold number explains the boot-time observations; the warmup already
   pre-warms the pool). Dependent chains — profile identity resolution is
   4–6 sequential GETs auto-pipelining cannot collapse — cost ~18–27ms, real
   but not user-visible next to upstream fetches. The optimization target is
   therefore the **robustness and O(N) fixes**, not round-trip elimination.
2. **Redis holds three very different kinds of data under one client:**
   irreplaceable platform state (pass-validity ledger, signed Seaport listings,
   profiles, follows, splits — Class A), rebuildable caches/indexes (ENS,
   Farcaster, smart-wallet, stats, sale indexes — Class B), and pure ephemera
   (sessions, rate limits, nonces, locks — Class C). They have opposite
   durability and latency needs; today they share one cross-cloud database.
   The classification (Part IV) is the backbone of the target design.
3. **The implementation quality is already high.** Auto-pipelining, write-side
   zset trims, 512-key MGET chunking, single-flight memoization with
   generation-counter invalidation, verify-then-consume nonces, NX idempotency
   on every money path, atomic Lua for counters/ledgers, lazy TTLs, negative
   caching with sentinels, and a coherent fail-open/fail-closed policy map.
   The remaining wins are structural (topology, a few data-model gaps), not
   hygiene.
4. **Two real cliffs and a handful of O(N)-per-request patterns remain:**
   `created-mints` unbounded SMEMBERS (hard-fails at Upstash's 10MB reply cap
   ~200k members), `searchProfiles` reading the entire profile index per
   username search, the listings feed materializing the newest 500 full JSON
   records on every GET, the timeline stitching moment-meta across the whole
   merged set pre-pagination, and the notification fan-out costing ~6–13 Redis
   commands per follower per mint.
5. **The cost framing in older docs is stale.** The "~1M cmds/mo vs 500K free
   cap" pressure dates from the free tier. Pay-as-you-go is $0.20/100K commands
   (≈$2/mo today; ≈$20/mo at 10× traffic); a fixed plan with **unlimited
   commands** is $10/mo (250MB) or $20/mo (1GB). Dollars should no longer
   drive design decisions; latency, the 10MB cliff, and durability classes
   should.

**Recommendation (LOCKED 2026-07-11, after measurement):** **stay
Upstash-only.** The measured steady-state RTT (~4.4ms) removed the case for a
co-located Redis tier — Option 4 (hybrid via
[SRH](https://github.com/hiett/serverless-redis-http)) is documented in §5.1
but **shelved**; revisit only if the app leaves the US-East metro, Upstash
moves, or a measured p99 regression says otherwise. The Global read-region
option is moot (already in the nearest region). The design is therefore:
PAYG + budget cap ($20, set) + Daily Backup (enabled) + the **robustness and
O(N) fixes in §5.2** — led by the `created-mints` cliff fix (SMISMEMBER),
listings record split, gate single-flight, `splitaddr` batch fix, profile
search index, bounded `collected` reads, and the fan-out ceiling. The
latency-motivated fixes (in-process rate limiter, session micro-cache,
identity-chain coalescing, notification trim amortization) drop to optional
at ~4ms RTT — they buy single-digit milliseconds and modest command savings.

---

# Part I — How Redis is used today

## 1. Client & global posture

One shared client, `lib/redis.ts`:

| Aspect | Setting | Why |
|---|---|---|
| SDK | `@upstash/redis` ^1.38.0 (REST/HTTP, stateless) | Serverless-safe; no connection pool |
| Pipelining | `enableAutoPipelining: true` (`redis.ts:36`) | Same-tick commands (every `Promise.all`, every `.map()` fan-out) collapse into ONE REST round trip — the single highest-leverage config already in place |
| Retries | capped at 2, jittered exp backoff (`redis.ts:46-49`) | SDK default of 5 turned Upstash blips into site-wide latency brownouts; also bounds blind-retry double-count on non-idempotent INCR/ZINCRBY |
| Env fallback | warn-and-placeholder, never throw (`redis.ts:19-27`) | Next.js build-time module loads must not kill the build |
| Health | passive: hot-path successes stamp `markRedisSuccess()` (`redisHealth.ts`); readiness PINGs only when idle >10s | Eliminates a 24/7 billed PING |
| Serialization | SDK auto-JSON on write **and** read | Load-bearing: `kv.ts` SADDs objects; `gateFlags.isFlagSet` exists because GET JSON-parses `'1'` → number `1` (shipped bug, 2026-05-24). Any client swap must preserve these semantics |

A second, non-pipelined probe client exists only in `/api/readiness`.

**Important SDK-semantics footnote:** `redis.multi()` and `redis.eval()` are
atomic server-side and are *not* merged by auto-pipelining. `Promise.all` of
plain commands is one round trip but **not** transactional (each command can
fail independently) — the codebase uses each correctly and deliberately.

## 2. The four caching tiers above Redis

| Tier | Mechanism | TTL | Scope | Used by |
|---|---|---|---|---|
| 1 | `memoize()` (`lib/memoCache.ts`) — TTL + single-flight + generation counter; errors never cached; writes call `.invalidate()` | 15 min (sets), 60s (identity closure, public earners) | per-process | all hidden-* sets, tracked/user collections, created-mints, pass-blacklist, action blacklist |
| 2 | Module-level caches | 15s (gate config, last-known-good), 10 min (pass-collection name), process-lifetime (scout spender) | per-process | `gate.ts`, `spender.ts` |
| 3 | React `cache()` | per-request | per-request | `fetchMomentDetail`, `getKvCreatorAddress`, `resolveCanonicalProfile`, `requestHiddenProfilesSet`, etc. — dedupes metadata+page double-renders |
| 4 | In-memory LRUs | 24h/2000 entries (smart wallet), 2048 entries (img totals) | per-process | `resolveSmartWallet`, `/api/img` |

Redis itself is additionally the durable cache tier for external systems: ENS
(1h/5m), Farcaster profile/verifications/primary (1h/5m/30s), smart-wallet
mapping (30d + reverse index), Chainlink ETH/USD (60s), media byte totals
(90d), on-chain verification verdicts (300s).

**What is deliberately NOT cached in-process:** `verifySession` (every authed
request hits Redis), `getMomentMeta`/`getCollectionMeta` (every moment SSR),
`getGateConfig` cold path (not single-flight), notification reads, listings
reads. These are the hot GETs the design must address.

## 3. Failure-policy contracts

Two helpers (`lib/redisRead.ts`) plus deliberate per-domain asymmetries:

| Policy | Applied to | Meaning of degradation |
|---|---|---|
| `safeRead` → fallback | session verify, profile theme, unread count, listings visibility wrapper, smart-wallet batch | page renders logged-out/unthemed/empty rather than 500 |
| `strictRead` / raw throw | hidden-moments, hidden-collections (content privacy) | error boundary; never reveal hidden content |
| Fail-OPEN | rate limits (`ratelimit.ts:43`), user quotas (`userQuota.ts:144`), airdrop quota, pass-blacklist read, hidden-users, scout locks/killswitch read | availability over enforcement — an outage silently disables abuse ceilings (documented, accepted; wallet-balance backstop) |
| Fail-CLOSED | pass-gate decision (`hasValidPass` → false on error), taint check at credit time (`isTokenTainted` → true), intent/auth nonce consumption (`.catch(()=>0)` → 401), admin sessions, platform-pause cold default (`paused:true`), earnings-visibility writes | money/moderation paths deny rather than over-permit |
| Last-known-good | gate config (`gate.ts:65`) | a blip can't flap the kill switch |
| Swallow + log | all notification writes, all `after()` side-effect writes, trending MULTI | side effects never break the parent operation |

## 4. Atomicity inventory

All atomic constructs in the codebase (each verified in place):

| Construct | Site | Guarantees |
|---|---|---|
| `RATELIMIT_LUA` (INCR + EXPIRE-if-first) | `ratelimit.ts:22` | no TTL-less counter can permanently lock an IP |
| `CONSUME_LUA` two-bucket quota | `userQuota.ts:106`, `airdrop-quota.ts:162` | atomic check-and-debit across day+week buckets |
| `ADJUST_BALANCE_LUA` / `SET_VALIDITY_LUA` / `CAS_BALANCE_LUA` | `pass-validity.ts:68,76,89` | validity ledger increments, admin grants, and drift clamp-down are race-free |
| `RECORD_PLATFORM_TX_LUA` (loop SADD + EXPIRE) | `pass-validity.ts:113` | a 200-recipient airdrop's platform flags = ONE command; no TTL-less key leak |
| `CREDIT_ROYALTY_LUA` (SET NX + HSET ledger + N×ZINCRBY) | `stats.ts:450` | royalty credit is exactly-once and all-or-nothing per fill |
| Lock-release compare-and-delete Lua | `leaderLock.ts:19`, `stats.ts:103` | a lease-expired predecessor can't delete a successor's lock |
| `MULTI` follow/unfollow | `follows.ts:12,19` | graph edges never half-write |
| `MULTI` trending (zincrby+trim+zadd+trim) | `collect/route.ts:253` | feed counters + caps atomic per collect |
| `MULTI` featured `zaddCapped` / display two-set | `featured/route.ts:10,102` | DISPLAY ⊆ FEATURED invariant |
| `MULTI` sale-index pipeline (adds/removes/sweeps) | `saleEnds.ts:124` | one round trip for the whole write-through batch |
| `MULTI` SADD+EXPIRE (read-ids, mutes, FC tokens) | `notifications.ts:388,416,431`, `farcasterNotifications.ts:113` | sliding TTL can't be dropped |
| `SET NX` idempotency/locks/slots | collect-idem, airdrop-idem, credited, processed, listing owned-slot, notif burst locks, fc push-sent, all scout locks, stats rebuild lock | first-writer-wins everywhere money or duplicates are at stake |
| `GETDEL` nonce consume | `profile.ts:248` | single-command read+burn |

**Notable:** every consume follows **verify-then-consume** ordering (signature
checked before the nonce is burned) so a forged-signature flood can't deny a
legitimate user. All Lua operates on 1–3 keys — nothing requires cross-slot
transactions, so **nothing in the codebase precludes Redis Cluster or any
single-node-compatible deployment**.

---

# Part II — The complete keyspace inventory

Legend — **Hotness:** 🔥 = on the per-request hot path; ▶ = per-user-action;
⏱ = cron/background; 🔧 = admin-only. **Fail:** O = fail-open, C = fail-closed,
S = swallowed/best-effort, LKG = last-known-good.

## II.1 Auth, sessions, nonces, limits, locks

| Key | Type | Writes (trigger) | Reads (caller) | TTL / bounds | Fail |
|---|---|---|---|---|---|
| `kismetart:session:{token}` | string (addr) | SETEX 7d login (`session.ts:27`); EXPIRE slide (`:121`, notif routes); DEL logout | 🔥 GET **every cookie-authed request + SSR page** (`session.ts:37`) — no in-process cache | 7d sliding | O (null=logged out) |
| `kismetart:auth-session:{token}` | string | SET EX 4h admin login; DEL logout | 🔧 GET per admin action (`curator.ts:45`, ~34 routes) | 4h, non-sliding | C (401) |
| `kismetart:auth-nonce:{n}` | string '1' | SET NX EX 300 (`auth/nonce:27`) | consumed via DEL after SIWE verify (`auth/login:63`) | 5 min | C |
| `kismetart:intent-nonce:{n}` | string '1' | SET NX EX 300 (`intentAuth.ts:40`) | ▶ consumed via DEL after EIP-712 verify (`:101`), per mint/write | 5 min | C |
| `kismetart:nonce:{addr}` | string | SETEX 300 (`profile.ts:237`) | ▶ **GETDEL** consume (`:248`) — follow, profile PUT, listing cancel | 5 min | C |
| `kismetart:rl:{route}:{ip\|id}` | string ctr | 🔥 EVAL INCR+EXPIRE — **every request**, ~56 sites/54 routes, all 60s windows, limits 5–120/min (`ratelimit.ts:38`) | (same EVAL) | 60s | **O** |
| `kismetart:uq:{kind}:{addr}:d/w` | string ctr ×2 | ▶ EVAL two-bucket check+debit per paid action (`userQuota.ts:136`); kinds: mint 50/250, write 50/250, collection 25/100, transcode 30/120, distribute 100/400, sign-calls 200/1000, update-uri 50/200, upload-bytes 500MB/2GB | (inside EVAL) | 25h / 8d | **O**; admin bypass |
| `kismetart:lock:{label}` | string token | ⏱ SET NX EX 60 acquire + Lua CAD release (`leaderLock.ts:34,42`), 'sweep-listings' every 5 min | (in Lua) | 60s | acquire throws→skip |
| `kismetart:fc:primary:{fid}` | string | SET EX 1h hit / 5m miss (`farcasterAuth.ts:69,77`) | 🔥 GET per Mini-App Bearer request fallback (`:54`) | 1h/5m; `''`=negative | O→live fetch |
| `kismetart:fc:identity:{fid}` | string | SET on identity change; DEL self-clean/erase (`farcasterAuth.ts:157,127,167`) | 🔥 GET per Bearer request w/o FidProfile (`:118`) | **none** (legacy) | O |

**Per-request command budget (measured from code):**
- Cookie-authed API request: **2–3 commands** (rl EVAL + session GET [+ EXPIRE slide on notification routes]).
- Mini-App Bearer request: rl EVAL + FidProfile GET + verifications GET + fallback identity/primary GETs + per-verified-wallet profile GETs — **a multi-read dependent chain**, the heaviest auth path.
- Mint/write POST (warm caches): **3–4** (rl EVAL + intent-nonce DEL + quota EVAL [+ memoized blacklist]); cold: up to ~13 (gate 3×GET fired 3× concurrently — see §3.3 — + SMEMBERS).
- SSR page (moment/profile/collection): +1 session GET each.

## II.2 Social graph & profiles

| Key | Type | Writes | Reads | TTL / bounds | Fail |
|---|---|---|---|---|---|
| `kismetart:following:{addr}` / `followers:{addr}` | set ×2 | ▶ MULTI[SADD,SADD] follow / [SREM,SREM] unfollow (`follows.ts:12-27`); purge on erase | SCARD counts O(1) (`:43,47`); SISMEMBER status (`:30`, also `isPriority` `notifications.ts:153`); **SMEMBERS full** for lists (`:35,39`) and **fan-out** (`notifications.ts:256`) | **unbounded** (+1/edge) | raw |
| `kismetart:profile:{addr}` | string JSON | ▶ SET upsert (`profile.ts:107`); DEL erase | 🔥 GET in canonical resolve + per-sibling (`:70`); MGET batch (`:86,194,213`) | none | raw/O |
| `kismetart:profile:fid:{fid}` | string JSON | ▶ SET (`:137,162`) | 🔥 GET canonical resolve (`:114`) | none | raw |
| `kismetart:profiles` | set | SADD on upsert/track (`:108,140,164,171`); SREM erase | **SMEMBERS ALL in `searchProfiles`** (`:183`) + MGET all for username search (`:213`); SISMEMBER in isPriority (`notifications.ts:155`) | **unbounded** (+1/wallet ever) | O |
| `kismetart:stats-public` | set (addr \| `fid:N`) | ▶ SADD/SREM; FC pin = MULTI move (`earningsVisibility.ts:125-148`) | SMEMBERS **memoized 60s** (`:52,58`) — profile route, OG image | none | read O; **write C** |
| `kismetart:profile-theme:{addr}` | string JSON | ▶ SET/DEL owner (`profileTheme.ts:65,69`) | 🔥 GET per profile SSR + OG (`:57` safeRead) | none | O |
| `kismetart:pins:{cat}:{addr}` | zset | ▶ ZADD (ZCARD+ZSCORE soft cap 4); ZREM; DEL ×3 erase (`showcase.ts`) | 3× ZRANGE per pins fetch (`:81-83`) | ≤4/cat | O |
| `kismetart:creator-lists` | hash | 🔧 HSET/HDEL (`creatorLists.ts:142,149`) | HGETALL homepage (`:72`); HGET one (`:119`) | none | O |
| `kismetart:ens:{addr}` | string | SET EX 1h/1h-''/5m-fail (`ensCache.ts:38-48`) | GET per cold profile resolve (`:25`) | 1h / 5m; forward-verified | O |
| `kismetart:fc:profile:{fid}` | string JSON/'' | SET EX 1h/5m/**30s transient** (`farcasterProfile.ts:146`) | 🔥 GET per identity resolve (`:72`) | 1h/5m/30s | O |
| `kismetart:fc:verifications:{fid}` | string JSON/''/'!transient' | SET EX 1h/5m/30s (`:281`); side-effect back-populates reverse index | 🔥 GET per sibling expansion (`:72`) | 1h/5m/30s | O; identity-writes treat null as C |
| `kismetart:fc:fid-by-addr:{addr}` | string | SET EX 30d per verified addr on any verifications fetch (`:300`) | 🔥 GET `getFidByAddress` — first hop of EVERY identity resolve (`:359`) | 30d refresh | O |
| `kismetart:fc:verified-x:{fid}` | string | SET EX 1h/5m (`:210`) | GET profile route (`:72`) | 1h/5m | O |
| `kismetart:smartwallet:{eoa}` + `smartwallet-owner:{sw}` | string ×2 | SET EX 30d both directions on live resolve (`smartWalletCache.ts:53-54`) | GET fallback (`:37`); MGET per profile view (`:73`); reverse MGET stats rebuild (`:95`); fronted by LRU(2000, 24h) | 30d | O |

**The profile identity chain (design-critical):** resolving one address =
GET `fid-by-addr` → GET `fc:profile` → GET `profile:fid` (or `profile`) →
GET `fc:verifications` → GET `profile` × siblings. **4–6 sequential dependent
GETs**; auto-pipelining cannot merge them (each depends on the previous). At
cross-cloud RTT this chain is the latency floor of every profile page, moment
page (creator chip), and batch `/api/profiles` call (×50).

## II.3 Notifications & Farcaster push

| Key | Type | Writes | Reads | TTL / bounds | Fail |
|---|---|---|---|---|---|
| `kismetart:notif:{addr}` | zset ts→JSON | ▶ ZADD + ZREMRANGEBYRANK(0,-201) per notification (`notifications.ts:215,219`); ZREMRANGEBYSCORE 60d lazy-TTL **on every read** (`:300`); DEL erase | ZRANGE **0..-1 (all ≤200)** per feed view, in-memory paginate (`:301,333`); ZRANGE BYSCORE 7d follow-dedup (`:173`) | cap 200; 60d lazy | S |
| `kismetart:notif-last-read:{addr}` | string ts | ▶ SET markAllRead (bell open fires it) (`:378`) | GET every feed/count read (`:302`) | none | raw |
| `kismetart:notif-read-ids:{addr}` | set | ▶ MULTI SADD+EXPIRE 30d (`:389`); DEL on markAll | SMEMBERS every read (`:303`) | 30d slide | raw |
| `kismetart:notif-muted:{addr}` | set | ▶ MULTI SADD+EXPIRE 1y / SREM (`:416,423`) | SMEMBERS every feed read (`:304`); SISMEMBER at push dispatch (`:408`) | 1y slide | O |
| `kismetart:notif-muted-types:{addr}` | set | ▶ MULTI SADD+EXPIRE 1y / SREM (`:431,439`) | 🔥 **SISMEMBER at top of every writeNotification** — fires once per fan-out recipient (`:167`) | 1y slide | raw |
| `kismetart:notif-unread-count:{addr}` | string | SET EX 3600 on recompute (`:361`); DEL on priority write + markRead (`:372`) | 🔥 GET **per bell poll — every 120s per visible authed tab** (`:353`; `NotificationBell.tsx:20`) | 1h safety net | O (null→recompute) |
| `kismetart:{type}-notif-lock:{r}:{a}:{token}` | string | SET NX EX 60 burst-dedup — collect & listing_created only (`:194`) | — | 60s | O (dup preferable) |
| `kismetart:fc:tokens:{fid}` | set JSON{url,token} | webhook MULTI SADD+EXPIRE 365d (`farcasterNotifications.ts:113`); SREM GC invalid (`:173`); DEL disable | SMEMBERS at dispatch (`:203`); SCARD (`:658`) | 365d slide; ≤100/req send | O |
| `kismetart:fc:push-types:{fid}` / `push-master:{fid}` / `push-seeded:{fid}` | set / string / string | seed + user PATCH (`:137,238,153,269,163`) | SISMEMBER / GET / GET per dispatch (`:249,260,123`) | 365d / 365d / 5y | O (default off) |
| `kismetart:fc:notif-sent:{fid}:{id}` | string | SET NX EX 24h per push (`:596`) | — | 24h | C (abort dispatch) |

**Fan-out formula (verified):** one mint by a creator with **F** followers, of
whom **p** have FC push fully enabled:

```
commands ≈ 1 (SMEMBERS followers)
         + 6·F   (per follower: SISMEMBER mute-type + ZADD + ZREMRANGEBYRANK
                  + DEL unread-count + 2-command push short-circuit)
         + ~7·p  (full push chain for enabled recipients)
         + 4–13  (minter's own notification)
```

≈ **6–13 commands per follower** (`_forcePriority` already skips 2 per-follower
reads). Listing fan-out adds one SET NX burst-lock per follower. Auto-pipelining
makes this few round-trips but every command bills. This is SCALING.md §3/B2's
celebrity-fan-out cliff, now quantified.

**Read paths:** feed GET ≈ 7 commands (5 of them one pipelined trip); badge
poll = **2 commands on cache hit** (session GET + count GET; deliberately no
session slide), 8 on miss. Bell polls every **120s** per visible tab, refetch
on focus; panel-open fires markAllRead (SET + 2 DEL).

## II.4 Moments, collections, moderation

| Key | Type | Writes | Reads | TTL / bounds | Fail |
|---|---|---|---|---|---|
| `kismetart:collections` | set | SADD per deploy (`kv.ts:138`) | SMEMBERS memoized 15m (`:73,80`) — timeline fan-out source; boot warm | unbounded (slow) | O→[platform] |
| `kismetart:created-collections` | set | SADD create-form deploys (`kv.ts:142`) | SMEMBERS memoized 15m (`:98,103`) — every collection surface | unbounded (slow) | O→[] |
| `kismetart:created-mints` | set `addr:tid` | ▶ SADD per mint (`kv.ts:122`) | **SMEMBERS FULL, memoized 15m** (`:115,118`) — Mints-feed filter | **unbounded, +1/mint ever — 10MB reply cliff ~200k members** | deliberate throw → timeline skips filter (`timeline:374`) |
| `kismetart:collection-meta:{addr}` | string JSON | SET on deploy/edit/backfill (`kv.ts:156,197,226`) — read-before-write to preserve createdAt | 🔥 GET per moment/collection SSR (`:235`); MGET batch (search, artist, hydrated) (`:254,278,324`) | none | O |
| `kismetart:moment-meta:{addr}:{tid}` | string JSON {creator,name,durationSec} | ▶ SET per mint (after()) (`notifications.ts:518` ← `mint-proxy:395`); boot backfill | 🔥 GET per moment SSR (React-deduped) (`:450`); **MGET chunked 512/req — timeline stitch over whole merged set** (`:495,487`) | none | batch→all-null |
| `kismetart:moment-content:{addr}:{tid}` | string ≤**200KB** (`momentContent.ts:9`) | ▶ SET per writing-moment mint (`:37`) | GET only when Arweave fetch fails on text-moment SSR (`page.tsx:236`) | none | S/O |
| `kismetart:authorized-creators:{coll}` | set JSON objs | 🔧 SADD + read-modify dedupe SREM (`kv.ts:400-431`) | SMEMBERS per panel (`:471`) | small | O |
| `kismetart:backfill:cover-momentmeta:v1` | string | boot SET when complete | boot GET (1/cold-start) | — | S |
| `kismetart:hidden-moments` / `hidden-collections` | set | 🔧 SADD/SREM + invalidate | SMEMBERS **memoized 15m** — every moment SSR, feed, market; boot-warmed | small | **C (throw)** |
| `kismetart:hidden-users` | set | 🔧 SADD/SREM + invalidate | SMEMBERS memoized 15m — feeds, search, market | small | O |
| `kismetart:hidden-profiles` | set | 🔧 SADD/SREM + invalidate | dual-path: memoized 15m (bulk) + **fresh SMEMBERS per page-gate** via React cache (`addressUnion.ts:120,125`); 60s-memoized sibling closure (`:103`) | small | O |
| `kismetart:hidden-listings` | set `c:t:seller` | 🔧 SADD; SREM lifecycle GC on cancel/fill/expire (`hiddenListings.ts:57,76`) | SMEMBERS memoized 15m via `getListingVisibility` (4-set Promise.all) — every market read | self-pruning | C |
| `kismetart:blacklist` | set | 🔧 SADD/SREM + invalidate (`blacklist.ts:74,79`) | SMEMBERS memoized 15m — mint, listing, airdrop paths (`:13,21`) | small | O |
| `kismetart:gate:enabled` / `gate:pass-collection` / `platform:paused` | string ×3 | 🔧 Promise.all SET/DEL (`gate.ts:82-88`) | 3× GET behind **15s module cache** (`:45-49,37`) — mint, collect, listings, airdrop, platform-status poll | none | **LKG; cold+down → paused=true (C), gate=open** |

## II.5 Feeds & sale indexes

| Key | Type | Writes | Reads | Bounds | Fail |
|---|---|---|---|---|---|
| `kismetart:trending` | zset member `coll:tid`, score=collect count | ▶ MULTI zincrby+trim(10k) per collect (`collect:255-256`) | ZRANGE 0..9999 rev per trending feed (`timeline:558`) | 10k cap both sides | write S; read raw |
| `kismetart:trending-latest` | zset score=last-collect ms | same MULTI zadd+trim (`:257-258`) | same read (latest-sales) | 10k | same |
| `kismetart:sale-ends` | zset score=saleEnd (s) | ▶ ONE MULTI per browse batch: zadd active + zrem inactive + throttled sweeps (score>24h-old, rank>10k) (`saleEnds.ts:124-151`); per-pod seen-cache; via `after()` from `/api/moments` + `/api/moment` | ZRANGE BYSCORE now→+inf LIMIT 10k per ending-soon feed (`:172`) | 10k | S / O→∅ |
| `kismetart:sale-free` | zset-as-set score=index-time | same MULTI (`:132-149`) | **ZRANGE 0 -1 (whole set)** per trending/latest feed (`:193`) | 10k cap; unbounded read ≤10k | S / O→∅ |
| `kismetart:featured` | zset | 🔧 MULTI zaddCapped(1000) (`featured:111`); zrem | ZRANGE 0..999 per GET /api/featured (**no cache header**) + timeline featured=1 pre-fan-out (`:39`; `timeline:189`) | 1000 | raw |
| `kismetart:featured-collections` | zset | 🔧 zaddCapped / zrem | ZRANGE 0..999 (GET) ; ZRANGE 0..19 hydrated route (revalidate=30) | 1000 / read 20 | raw |
| `kismetart:featured-moment-displays` | zset (1 member) | 🔧 DEL then two-set MULTI (DISPLAY⊆FEATURED) (`featured:98,102-107`) | ZRANGE per GET | 1 | raw |
| `kismetart:collected:{addr}` | zset `coll:tid`→ts | ▶ ZADD per collect (`collected.ts:26` ← collect:261) + per airdrop recipient; DEL erase | **ZRANGE 0..-1 (unbounded)** per Collected tab × FC sibling (`:36`; `timeline:172`); ZSCORE single (`:53`) | **unbounded** | O |

## II.6 Marketplace (Seaport order book)

| Key | Type | Writes | Reads | Bounds | Fail |
|---|---|---|---|---|---|
| `kismetart:listings` | zset id→createdAt | ▶ ZADD create (`listings.ts:88`); ZREM on fill/cancel/expire/ghost/erase | **ZRANGE 0..499 rev per feed GET** (`:221`) + sweep | scan window 500 | raw |
| `kismetart:listing:{id}` | string JSON (signed order + display meta, ~2–4KB) | ▶ SET create/status; DEL only on erase | GET single; **MGET ≤500 per feed GET** (`:111,131`) | **terminal records linger forever** | raw |
| `kismetart:listings:owned:{c}:{t}:{seller}` | string=id | ▶ **SET NX slot claim** (`:74`) — the concurrency gate; SET takeover if incumbent inactive; DEL terminal | GET incumbent + deeplink (`:78,151`) | 1/token/seller | C (409) |
| `kismetart:listings:seller:{s}` | set ids | ▶ SADD create; DEL LAST on erase (`:91,335`) | SMEMBERS + MGET per seller view (`:257`) | never SREM'd (deliberate) | raw |
| `kismetart:listing-notified:{id}` | string | SET NX EX 7d (sweep, one-notif claim) (`:176`) | — | 7d | S |

**Listings feed anatomy (per GET, any page):** 4× SMEMBERS hidden (memoized) +
ZRANGE(500) + **MGET(≤500 full-JSON records ≈ 1–2MB)** + in-JS filter/paginate.
This is the single largest bandwidth consumer per request in the app.

## II.7 Stats, earnings, splits

| Key | Type | Writes | Reads | Bounds | Fail |
|---|---|---|---|---|---|
| `kismetart:stats:mints` / `earned:eth` / `earned:usdc` (+ `:staging` ×3) | zset artist→val | ⏱ hourly rebuild: DEL staging → chunked ZADD(1000) → **MULTI RENAME staging→live** (`stats.ts:162-179`); zero-wipe ZCARD guard (`:309`), shrink guard vs `last-rebuild` (`:324`) | 5× ZMSCORE one pipelined trip per stats view (`:403-408`) | rebuilt from inprocess `/transfers` | C guards |
| `kismetart:stats:royalty:eth` / `usdc` | zset | ▶ ZINCRBY inside CREDIT_ROYALTY_LUA per fill (`:556`) — **event-driven, NOT wiped by rebuild** | ZMSCORE (same trip) | forward-accrual | Lua atomic |
| `kismetart:stats:royalty-ledger` | hash listingId→JSON | ▶ HSET in same Lua | **never read** (future reconcile journal) | unbounded (slow) | — |
| `kismetart:royalty-credited:{listingId}` | string | SET NX in Lua — **no TTL (permanent claim)** | — | +1/fill | C |
| `kismetart:stats:last-rebuild` / `rebuild-lock` | string | SET after success / SET NX EX 900 + Lua CAD release (`:351,190,198`) | GET guard | 900s lock | O |
| `kismetart:splits:{c}:{t}` | string JSON recipients | ▶ SET per split-mint (after()) (`splits.ts:43`) | GET distribute/royalty decompose (`:132`) | none | raw |
| `kismetart:splits:by-recipient:{addr}` | set `c:t:pct` | ▶ SADD at mint + self-heal (`:65`) | SMEMBERS in pending rollup + timeline airdroppable (`:105`) | none; NOT erased (financial) | O→[] |
| `kismetart:splits:healed:{c}:{t}` | string | SET NX EX 7d heal-once (`:87`) | — | 7d | S |
| `kismetart:splitaddr:{c}:{t}` | string addr | SET on first on-chain resolve (`pending.ts:75,128`) | **GET in a per-token loop `stats.ts:593` (N+1)**; MGET batched (`pending.ts:105`) | **no TTL, immutable, unbounded** | O→chain |
| `kismetart:pending:{addr}` | string JSON | SET EX 60 (`pending.ts:262`) | GET owner stats (`:248`) | 60s; compute capped 100 moments/4s | O |
| `kismetart:ethusd` | string | SET EX 60 (`ethPrice.ts:38`) | GET per earnings view (`:28`) | 60s | O→null |
| `kismetart:royalty-audit:wallet/contract` + `royalty-split-audit` | ctr ×2 + list | INCR / INCR+LPUSH+LTRIM(500) per royalty fill (`royaltyAudit.ts:56,80-81`) | manual inspection only | 500 | S |

## II.8 Pass gate (provenance token-gate)

| Key | Type | Writes | Reads | TTL | Fail |
|---|---|---|---|---|---|
| `kismetart:pass:valid-balance:{c}:{a}` | string int | ADJUST_BALANCE_LUA ±n (credit `pass-validity.ts:485`, webhook decrement `:379`); SET_VALIDITY_LUA admin; CAS clamp-down (`:564`) | GET per gate check (`:508`) + badge poll + admin | none | **C on gate** |
| `kismetart:pass:admin-grant:{c}:{a}` | string | set/del inside Lua | GET in hasValidPass (`:515`) | none | O→reconcile |
| `kismetart:pass:platform-tx:rcpt:{tx}` | set `addr:tid` | RECORD_PLATFORM_TX_LUA (N recipients = 1 cmd) from collect/mint/airdrop/fill after() with 4-try backoff | SISMEMBER per webhook transfer (`:180,366`) | 90d | throws after retries |
| `kismetart:pass:tainted:{c}` | set tid | SADD webhook off-platform transfer (`:403`); SREM admin | SISMEMBER at credit — **C (true on error)** (`:290`); SMEMBERS in hasValidPass — **O (∅ on error)** (`:304`) | **permanent** | asymmetric by design |
| `kismetart:pass:kismet-listed:{c}:{t}:{s}` | string | SET EX=listing lifetime on Pass listing (`:198`); DEL fill/cancel/sweep | GET per webhook (false-taint guard) (`:393`) | listing lifetime | S |
| `kismetart:pass:credited:{c}:{a}:{tx}:{t}` | string | **SET NX EX 90d** credit CAS (`:475`) — blacklist+taint checked BEFORE | — | 90d | C |
| `kismetart:pass:processed:{tx}:{log}:{sub}` | string | **SET NX EX 30d** webhook event idempotency (`:351`) | — | 30d | C |
| `kismetart:pass:tokenids:{c}` | set | SADD fire-forget (webhook+credit) (`:358,483`) | SMEMBERS in hasValidPass (`:272`) | none | O→ledger |
| `kismetart:pass-blacklist` | set | 🔧 SADD/SREM + invalidate | SMEMBERS memoized 15m (gate + credit + badge) (`pass-blacklist.ts:41,49`) | none | **O** (gate itself fails C) |

## II.9 Airdrops & Agent-Scout

| Key | Type | Writes | Reads | Bounds | Fail |
|---|---|---|---|---|---|
| `kismetart:airdrops:sender:{s}` / `airdrops:moment:{c}:{t}` | zset ×2 ts→JSON | ▶ 2×ZADD + 2×trim(500) per airdrop recipient (`airdrops.ts:77-86`) | ZRANGE rev profile tab / comments first page (`:106,128`) | 500 each | O |
| `kismetart:airdrop-quota:{artist}:d/w` + `limit:day/week` | ctr ×2 + cfg ×2 | ▶ CONSUME_LUA per Pass airdrop (`airdrop-quota.ts:193`); 🔧 SET limits | GET ×2 status route; GET ×2 limits | 25h/8d; day=1 wk=5 default | **O** |
| `kismetart:airdrop-idem:{tx}:{c}:{t}:{s}` | string | SET NX EX 30d BEFORE quota debit (`notify:223`) | — | 30d | C (503) |
| `verify:airdrop:...` / `verify:collect:...` | string | SET EX 300 verdict cache (**no `kismetart:` prefix**) (`notify:115`; `collect:52-83`) | GET before RPC (`:68`; `:45`) | 300s | O; RPC-fail not cached |
| `kismetart:collect-idem:{tx}:{c}:{t}:{a}` | string | SET NX EX 30d (`collect:188`) | — | 30d | **C (503)** |
| `kismetart:airdrop-delegates:{c}:{t}` + `by-wallet:{w}` | set ×2 | 🔧 paired SADD/SREM (`airdropDelegates.ts:42-57`) | SMEMBERS admin UI / timeline airdroppable (`:67,84`) | none | O |
| `kismetart:scout:{owner}` | string JSON (multi-KB: policy+budget+usage+signed permission) | ▶ SET on PUT / per-run persist / per-coordinated-collect (read-modify-write) (`store.ts:108`) | GET per run/CRUD; **MGET batch in drop coordinator** (`:75,93`) | ≤50 creators, ≤5 superseded | O |
| `kismetart:scout-watchers:{artist}` | set | SADD/SREM diff on save (`:64-65`) | SMEMBERS × sibling-wallet per drop coordination (`dropCoordinator.ts:107`) | none | O→[] |
| `kismetart:scout-killswitch` | string | 🔧 SET/DEL | GET per run + per drop (`runScoutServer:120`; `dropCoordinator:85`) | none | O (on-chain caps back-stop) |
| `kismetart:scout-run:{owner}` / `scout-drop:{c}:{t}` / `scout-collect:{r}:{c}:{t}` / `scout-spender-lock:{sp}` | string locks | SET NX EX 120 / 86400 / 120 / 240 (+poll 200ms, wait 45s) + DEL release | — | crash-safe TTLs | O (proceed unserialized) |

**Scout multipliers:** per-user run ≈ 8 + 4·D lock commands (D = drops
collected); per-drop coordination ≈ 3 + W SMEMBERS + 1 MGET + 6·A (W watchers,
A allocations) — plus each collect fires the full `/api/collect` chain.

## II.10 Media & misc

| Key | Type | Writes | Reads | TTL | Fail |
|---|---|---|---|---|---|
| `img:total:{uri}` | string bytes (**no `kismetart:` prefix**) | SET EX 90d write-behind on learned total (`img/route.ts:71`) | GET only on cold-memory ranged request (`:78,395`); L1 LRU(2048) | 90d | O→count-through |

---

# Part III — Workload characterization

## 3.1 The hot list (commands ranked by expected volume)

| Rank | Command(s) | Driver | Volume driver | Cacheable? |
|---|---|---|---|---|
| 1 | `EVAL` rate-limit | every API request, 54 routes | traffic | trivially (single instance) |
| 2 | `GET session:{token}` | every cookie-authed request + 4 SSR page types | traffic | yes (short TTL) — currently NOT |
| 3 | `GET notif-unread-count` + session GET | bell poll 120s/visible tab (`NotificationBell.tsx:20`; ~90 ops/hr/user, comment `:17-19`) | DAU × dwell | already Redis-cached; still 2 cross-cloud RTTs per poll |
| 4 | identity-chain GETs (fid-by-addr → fc:profile → profile[:fid] → verifications → siblings) | profile/moment SSR, /api/profiles ×50, Bearer auth | page views | partially (per-request React cache only) |
| 5 | `MGET moment-meta` ×512-chunks | timeline stitch, whole merged set pre-filter (`timeline:310`) | feed loads × collection count | 30s s-maxage on non-personalized only |
| 6 | `ZRANGE listings(500)` + `MGET listing(≤500)` | every market feed GET | market traffic | uncached today |
| 7 | `EXPIRE` session slide + notif feed 5-command read | notification routes | bell opens | partially |
| 8 | gate 3×GET | 15s module cache; cold burst ×3 callers (§3.3) | mostly absorbed | yes (fix single-flight) |
| 9 | SMEMBERS hidden-*/blacklist/collections | 15-min memoize per process | near-zero steady-state | already solved |
| 10 | collect/mint write bursts (~10–20 cmds each incl. after()) | per purchase/mint | sales | n/a (writes) |

Everything below rank 10 (admin, cron, scout, webhooks) is noise by volume.

## 3.2 Round-trips vs commands

Auto-pipelining already collapses same-tick clusters (the notif 5-read
Promise.all, the 5× ZMSCORE stats read, MGET chunks) into single round trips.
What it **cannot** collapse:

- **Dependent chains** — identity resolve (4–6 serial RTTs), `hasValidPass`
  (up to 5 serial steps: config → blacklist → balance → admin-grant →
  tokenids+tainted → CAS), listings create slot-claim (SET NX → GET → GET),
  scout spender-lock poll loop (200ms poll = 1 cmd per poll tick).
- **Sequential guards** — rl EVAL *then* session GET *then* handler reads (three
  awaited layers in most routes).

At a cross-cloud RTT of r ms, a profile page pays ≈ (4–6)·r before content
work; every authed API call pays ≥2·r of pure guard latency. **Measured
2026-07-11 (10 timed PINGs from inside the app container): r ≈ 4.4ms median
steady-state (3.7–7.9ms spread; 162ms cold first-connection).** So today:
guard latency ≈ 9ms/request, worst identity chain ≈ 18–27ms, bell poll ≈ 9ms —
real numbers, but an order of magnitude below the upstream inprocess fetches
on the same pages. This measurement is what shelved the co-location option
(§5.1): converting 4.4ms to loopback isn't worth owning another stateful
service on a zero-redundancy box. Dependent-chain *coalescing* (§5.2 #12)
remains the cheap way to claw back the profile-chain milliseconds if wanted.

## 3.3 Redundant-read findings (code-level, all cheap fixes)

1. **`getGateConfig` is not single-flight** (`gate.ts:45`): `mint-proxy.ts:148-153`
   calls `isPlatformPausedFor` + `hasGateAccess` + `getGateConfig` concurrently;
   on a cold/expired 15s cache all three fetch → **9 GETs** in one burst.
   A shared in-flight promise (the `memoize` pattern already in the repo)
   makes it 3.
2. **`splitaddr` N+1** (`stats.ts:593`): royalty decomposition GETs one split
   address per token in a loop, while `pending.ts:105` already has the batched
   MGET (`resolveSplitAddresses`). Loop path should use the batch.
3. **Session slide fires per request** on notification routes
   (`session.ts:121`) — an EXPIRE whose effect only matters at day granularity
   on a 7-day TTL. An in-process "last slid at" map (slide at most hourly per
   token) removes ~all of them.
4. **`getMomentMetaBatch` runs pre-filter over the whole merged timeline set**
   (`timeline:310`) — meta is needed pre-filter only for creator-override
   scopes and hidden-users-by-artist filtering; for default/trending scopes the
   page slice (≤ limit) would suffice if the artist-hide filter moved
   post-slice or used a small creator-index. Width today ≤ MERGE_BUDGET
   (5k/10k) ≈ up to ~350KB and thousands of billed key-reads per uncached load.
5. **Notification trim per write** (`notifications.ts:219`): ZREMRANGEBYRANK
   accompanies every ZADD. The read path already prunes (`:300`); trimming
   probabilistically (e.g. 1-in-8 writes) or read-side-only cuts 1 command per
   fan-out recipient with the same effective bound.
6. **`kismetart:profiles` full-set username search** (`profile.ts:183,213`):
   SMEMBERS all wallets + MGET all profiles per non-address search — O(users)
   per keystroke-ish. Needs an index (see §5.3).
7. **Featured GET has no cache header** (`featured/route.ts:39`) — three ZRANGEs
   per request for near-static curated data; `s-maxage=30` matches the
   timeline's posture.
8. **`verify:*` and `img:total:*` lack the `kismetart:` namespace** — cosmetic,
   but matters the day anything else shares the database. The production Data
   Browser also shows a leftover **`debug:ua-seen`** SET (8 UA strings, no
   TTL) written by an earlier `lib/deviceUA.ts` debugging pass — delete it or
   give it a TTL.

## 3.4 Write amplification map

| Event | Redis writes (approx) | Notes |
|---|---|---|
| Collect | ~10 sync+async cmds: idem NX, verify cache, MULTI×4 trending, ZADD collected, platform-tx Lua, credit chain (3–5), notif (~6), meta GET | bounded, well-batched |
| Mint | meta SET, content SET (writing), splits SET+SADD, created-mints SADD, platform-tx Lua, credit chain, self-notif, **fan-out 6–13·F** | fan-out is the only unbounded term |
| Listing create | slot NX + 3 writes + kismet-listed + **fan-out 7–14·F** | same |
| Airdrop (N recipients) | idem NX + quota Lua + N×(credit chain + 2 ZADD + 2 trim + notif ~6) + 1 batched platform-tx Lua | linear in N, capped by quota (day=1, wk=5) and 500-member zset trims |
| Webhook transfer | processed NX + SISMEMBER + Lua adjust + optional taint/credit | ~4–8, idempotent |
| Scout drop (W watchers, A allocations) | 3 + W SMEMBERS + MGET + 6A + A×collect-chain | W bounded by artist popularity |

## 3.5 Growth ledger (what grows forever)

| Key family | Growth rate | Bounded read? | Risk |
|---|---|---|---|
| `created-mints` | +1/mint ever | **NO — full SMEMBERS** | **cliff at ~200k members (10MB reply)** — the one hard availability cliff left |
| `moment-meta` / `collection-meta` / `moment-content` / `splits*` / `splitaddr` | +1/mint | point GETs / bounded MGETs | storage only (fine; all <1KB except content ≤200KB) |
| `profile*`, `profiles` set | +1/wallet | **searchProfiles reads ALL** | O(users) search cost |
| `followers/following` | +1/edge | SMEMBERS on lists + fan-out | celebrity fan-out (B2) |
| `collected:{addr}` | +1/collect | **ZRANGE 0..-1** | heavy collectors → big reads (bound it) |
| `listing:{id}` records | +1/listing (terminal linger) | feed reads newest 500 only | storage + seller-view width |
| `notif:{addr}` | capped 200 + 60d | ✓ | none |
| trending/latest/sale-ends/sale-free/featured | capped 10k/10k/10k/10k/1k | ✓ (sale-free reads whole ≤10k set) | none structural |
| pass ledger/taint/idem | +slowly; idem TTL'd 30–90d | point reads | none |
| `royalty-ledger` hash + `royalty-credited:*` | +1/fill, no TTL | never read / claim-only | storage (fine, deliberate journal) |

## 3.6 Corrections to prior docs (verified this review)

- **SCALING.md §4d "10 MB writing-moment bodies in Redis" is stale**: the Redis
  mirror is capped at **200KB** (`momentContent.ts:9,30`); 10MB is only the
  upstream-forward cap (`mint-proxy.ts:27`). Redis-side large-value exposure is
  bounded and conditional-read-only.
- **The cost pressure framing ("~1M cmds/mo vs 500K free cap") predates PAYG**:
  at 2026 PAYG pricing ~1M cmds/mo ≈ $2/mo (see §4.4). Free-tier caps should no
  longer shape design.
- SCALING.md §4c's correction stands and is re-confirmed: baseline is 2–3
  commands per authed request, not "40/request" (40 = count of rate-limited
  endpoints).

---

# Part IV — The specific needs, made explicit

The phrase "our very specific needs" cashes out as five hard requirements the
current single-database design serves unevenly.

## 4.1 Durability classes (every key family classified)

**Class A — irreplaceable if lost (the platform's books and social fabric):**
profiles (`profile*`, `profiles`), follows graph, notification inboxes +
read/mute state (soft-A), pass-validity ledger + taint + admin grants +
`credited`/`processed`/`platform-tx` idempotency (money-adjacent), **listings
(signed Seaport orders!)** + owned-slots + seller index, splits + by-recipient
+ royalty zsets + royalty ledger + `royalty-credited`, airdrop records + quota
config, collections/created-collections/**created-mints** registries,
collection/moment meta + moment content, authorized-creators, hidden-* +
blacklists (moderation), gate flags, featured sets, creator-lists,
earnings-visibility, scout records + watchers + killswitch, `fc:identity`,
`collected` zsets (event-sourced, not rebuildable), trending/trending-latest
(technically derived, but the collect event stream isn't stored anywhere else —
loss = counters reset; decide product-side whether that's acceptable or worth a
periodic dump).

**Class B — rebuildable caches/indexes (loss = recompute cost only):**
ENS, all `fc:*` caches (profile/verifications/fid-by-addr/verified-x/primary),
smart-wallet map (30d, re-resolvable), `ethusd`, `img:total`, `verify:*`
verdicts, `pending`, `splitaddr` (re-derivable on-chain), stats
mints/earned (hourly rebuild from inprocess `/transfers`), sale-ends/sale-free
(self-backfilling from browse traffic), `splits:healed`, cover-backfill marker.

**Class C — ephemeral by definition:** sessions (user + admin; loss = re-login,
already the accepted Redis-outage behavior), all nonces, rate-limit counters,
user/airdrop quota buckets (loss = reset, fail-open philosophy), all locks
(leader, scout ×4, rebuild), notification burst locks, `fc:notif-sent` (24h),
`listing-notified`, unread-count cache.

**Consequence:** only Class A actually requires managed off-box durability.
Classes B and C — which include the entire per-request hot path — do not.

## 4.2 Latency classes

| Class | Keyspaces | Requirement |
|---|---|---|
| Per-request guards | rl, session, gate, unread-count | as close to 0 as possible; every request pays them serially |
| Interactive SSR | moment-meta, collection-meta, profile identity chain, theme, hidden sets, listings feed | sum of serial reads < ~50ms budget |
| Write-behind / after() | trending, sale indexes, notif fan-out, platform-tx, meta writes | latency-insensitive; command-count-sensitive |
| Cron/admin | stats rebuild, sweeps, featured writes | insensitive |

## 4.3 Atomicity & semantics requirements

- Lua on 1–3 keys + MULTI + NX + GETDEL — **any Redis-compatible engine
  (Redis, Valkey) satisfies every construct in use**; nothing needs cross-node
  transactions, keyspace notifications, or modules.
- The Upstash SDK's **auto-JSON serialization is a compatibility constraint**:
  values were written via SDK auto-serialize (objects in sets, numbers in
  flags). Any client/topology change must keep reading those shapes —
  the SRH path (§5.1) preserves the SDK precisely for this reason.

## 4.4 Cost reality (verified 2026-07)

| Plan | Price | Limits |
|---|---|---|
| Free | $0 | 500K cmds/mo, 256MB, 10MB max request |
| Pay-as-you-go | **$0.20 / 100K cmds**; storage $0.25/GB-mo past 1GB free; bandwidth free ≤200GB/mo then $0.03/GB | 10MB max request |
| Fixed 250MB | **$10/mo, unlimited commands** | 50GB bw/mo |
| Fixed 1GB | **$20/mo, unlimited commands** | 100GB bw/mo |
| Fixed 5GB | $100/mo | 500GB bw/mo |

**Observed (console, 2026-07-11): 579K cmds month-to-date → $1.16; 336KB data
(matches the 335.74KB manual backup taken the same day); run rate ~50–70K
cmds/day (~1.5–2M/mo ≈ $3–4/mo); ~20MB/day bandwidth.** PAYG is therefore optimal today and stays cheaper than the
Fixed-250MB plan until ~5M cmds/mo; **budget cap set 2026-07-11 at the $20
console minimum rather than switching plans** — note the cap **hard-stops the
database** when reached (runaway protection with ~5–6× headroom; recovery =
raise the cap in the console). Bandwidth becomes the number to watch
only if market/feed traffic grows ~100×: the listings feed's ~1–2MB MGET and
the timeline's merged-set MGET are the movers, and a later move to
Fixed-250MB would hit its 50GB/mo ceiling first. Sources:
[Upstash pricing](https://upstash.com/pricing/redis),
[docs](https://upstash.com/docs/redis/overall/pricing), request-size limit
verified against
[upstash/docs `max_request_size_exceeded.mdx`](https://raw.githubusercontent.com/upstash/docs/main/redis/troubleshooting/max_request_size_exceeded.mdx).
(Per-plan throughput throttles live only in JS-rendered pages — re-confirm
before quoting.)

## 4.5 Topology & future constraints

- Single Oracle Ampere box (ARM64, ~11GB RAM, 200GB disk), Coolify, zero
  redundancy; Upstash in AWS us-east-1. The runbook's cross-cloud-latency
  concern (`OPS_RUNBOOK.md:83`) is now **measured: ~4.4ms steady-state,
  162ms cold** (2026-07-11, from inside the app container) — same-metro
  adjacency, not a constraint at steady state.
- Code is multi-pod-aware (Redis locks, sessions in Redis) but memoize tiers
  are per-pod (15-min cross-pod staleness if pods are added) — any redesign
  should not worsen the path to 2+ pods.
- Roadmapped end-state (SCALING.md B3): Postgres as system of record for
  list-shaped data; Redis demoted to cache/counters/locks. The durability
  classes above are exactly the migration inventory for that move.

---

# Part V — The optimized design

## 5.1 Topology: options analysis

**Option 1 — status quo (Upstash PAYG, everything cross-cloud).**
Zero effort. Keeps paying r-ms per command on guards and 4–6r on identity
chains; keeps 10MB cliff exposure; cost trivial. Fine at today's traffic,
increasingly felt as DAU grows.

**Option 2 — Upstash-only + code-level fixes.**
Stay PAYG with a budget cap (at observed $1.16/mo, a fixed plan costs more
until ~5M cmds/mo); §5.2 fixes remove the worst O(N) reads and redundant GETs.
Latency floor unchanged (cross-cloud). The right move **if** operational
simplicity outweighs latency (one managed store, no new moving parts).

**Option 2b — Upstash Global read region near the box (zero infra, zero code).**
The database is already Global-type; adding a read region in the Upstash
region closest to the Oracle VM makes the REST endpoint route reads (86% of
traffic) to the nearby replica automatically. Costs: +$? per-region flat on
some plans, and every write bills once per region (writes are 14% ≈ 79K/mo →
trivial). **Caveats:** (a) only worth it if an Upstash-supported region is
materially closer to the box than `us-east-1` — needs the box's region + a
measured RTT first; (b) replica reads are eventually consistent, which breaks
read-your-write flows — `createSession` → immediate `verifySession` on the
login redirect, scout `getScout`→`saveScout` read-modify-write cycles, and
listing create → immediate feed read could observe pre-write state for
~ms–100ms. Those specific flows would need to pin to the primary (REST header)
or tolerate the lag. **Resolved 2026-07-11: moot** — the measured 4.4ms RTT
means the app is already effectively adjacent to the primary region; no
Upstash region is meaningfully closer.

**Option 3 — full co-location (move everything to Redis-on-box).**
Kills all cross-cloud latency and all Upstash cost, but makes the single box a
**total-loss SPOF for Class A data** (signed listings, validity ledger,
profiles). Snapshot-shipping (AOF everysec + hourly RDB to Oracle Object
Storage) bounds RPO to ~1h for disaster — still a real regression vs a managed
replicated store, on a box the runbook itself calls zero-redundancy. **Not
recommended while Redis is the only datastore.**

**Option 4 — hybrid tiering: Upstash = durable Class A/B-slow; box-local
Redis = Class C + hot Class B. — SHELVED 2026-07-11 after measurement.**
This was the working recommendation while cross-cloud RTT was presumed to be
tens of milliseconds; the measured ~4.4ms steady-state removed its payoff
(each command saved ≈4ms, at the price of owning a second stateful service on
a zero-redundancy box). Kept in full below as the ready-to-execute playbook
for the conditions that would revive it: the app relocating out of the
US-East metro, Upstash moving/regressing, or a sustained measured p99
problem attributable to Redis round trips.

Mechanics:
- Run `redis:7-alpine` (or Valkey) as a Coolify service on the box +
  [SRH](https://github.com/hiett/serverless-redis-http)
  (`hiett/serverless-redis-http`, nightly-tested against `@upstash/redis`;
  endorsed by [Upstash's own dev docs](https://upstash.com/docs/redis/sdks/ts/developing))
  in front of it. Add `lib/redisHot.ts` = a second `Redis` instance pointed at
  SRH. **Zero semantic drift**: same SDK, same auto-serialization, same
  pipelining; each lib module just imports its client from one of two modules.
- Move keyspaces by class, one PR each, in this order (volume-ranked):
  1. `rl:*` (or replace with in-process limiter while single-instance — see
     §5.2-1) — kills the #1 command.
  2. `session:*` + `auth-session:*` + all nonces — kills the #2 GET. Tradeoff:
     box death logs everyone out (already the accepted Redis-outage behavior).
  3. `notif-unread-count` (+ its DEL invalidations) — the poll becomes 2
     loopback reads.
  4. `fc:*` identity caches + `ens:*` + `smartwallet*` + `ethusd` +
     `verify:*` + `img:total:*` — the identity chain's 4–6 serial RTTs become
     loopback; all rebuildable.
  5. Locks + quotas + burst locks + `fc:notif-sent`.
- **Stays on Upstash:** everything in Class A (§4.1) including money-adjacent
  idempotency (`credited`/`processed`/`collect-idem`/`airdrop-idem` — these
  guard against double-crediting across deploys and must survive the box),
  plus trending/collected unless a periodic dump is added.
- Ops: `appendonly yes` (everysec), `maxmemory` ~1–2GB with `noeviction`
  (Class C data must not be silently evicted — sized generously it never
  will), Docker volume, healthcheck. The readiness probe should treat local
  Redis like it treats RPC today: degraded, non-gating (Upstash remains the
  gating dependency).
- Failure semantics are *already correct* for this split: every keyspace moving
  local is fail-open (rl, quotas, caches) or fail-open-to-logged-out
  (sessions) by existing design.

Effect estimate (volume-ranked list §3.1): ranks 1, 2, 3, most of 4, and 7
move to loopback ⇒ **~70–90% of Upstash commands eliminated** (consistent with
the runbook's "GET-dominated" observation), per-request guard latency →
sub-ms, identity chains → sub-ms, and Upstash PAYG cost likely drops back
under the free tier. Class A durability unchanged. Multi-pod path: a second
pod on the same box shares the local Redis; pods on a second box would point
at box-1's Redis over private network (or each keep their own for
rl/sessions-sticky decisions at that time).

**Option 5 — Postgres system-of-record (SCALING.md B3).**
The correct end-state for list-shaped Class A data (listings, follows,
notifications, registries, ledger journals) with keyset pagination; demotes
Redis to cache/counters/locks and unlocks N stateless pods. It is a
re-platforming, not a Redis optimization — sequenced after the hybrid split
(which is also its preparation: the Class A inventory above is the table list).

**Recommendation (locked 2026-07-11): Option 2 — Upstash-only, PAYG + $20
budget cap (set) + Daily Backup (enabled) + the §5.2 fixes, robustness-first.**
The RTT measurement (~4.4ms steady-state from inside the app container)
resolved the topology question: Options 2b, 3, and 4 are all shelved/moot.
Priority within §5.2 shifts accordingly — the cliff/O(N)/robustness fixes
(#3 #4 #5 #6 #8 #9 #13 #14) carry the plan; the latency/cost-motivated ones
(#1 #2 #7 #12) become optional nice-to-haves at ~4ms RTT and ~$3–4/mo.

## 5.2 Code-level fixes (no topology change; ranked by impact/effort)

| # | Fix | Where | Impact | Effort |
|---|---|---|---|---|
| 1 | **In-process rate limiter** behind the existing `checkRateLimit` signature while single-instance (env-flag back to Redis for multi-pod) — or move `rl:*` to local Redis | `lib/ratelimit.ts` | removes the #1 command (1 EVAL/request) | S |
| 2 | **Session micro-cache**: in-process LRU {token→addr} TTL 30–60s + `.invalidate()` on logout; slide EXPIRE at most 1×/hour/token via last-slid map | `lib/session.ts` | removes most #2 GETs + slide EXPIREs; revocation latency ≤60s (immediate own-pod) | S |
| 3 | **`created-mints` cliff fix**: replace full `SMEMBERS` with `SMISMEMBER(CREATED_MINTS_KEY, ...pageCandidates)` for the standalone filter (bounded by merged width, 1 command); later dual-write a ZSET (`score=mint-ts`) for a real bounded Mints index (B1 synergy) | `lib/kv.ts:115`, `timeline:369` | **removes the one hard availability cliff** | S / M |
| 4 | **Listings record split**: `listing:{id}` → `listing-meta:{id}` (~300B: price, token, seller, status, image) + `listing-order:{id}` (signed order, fetched only at fill/deeplink); feed MGETs metas only. Plus 15–30s in-process feed cache (single pod) | `lib/listings.ts` | ~10× bandwidth cut on the biggest per-request payload; feed latency | M |
| 5 | **`getGateConfig` single-flight** (share in-flight promise; optionally collapse the 3 keys into one JSON/HASH value = 1 GET) | `lib/gate.ts:45` | kills the 9-GET cold burst on the mint path | S |
| 6 | **`splitaddr` batch fix**: use `resolveSplitAddresses` MGET in the `stats.ts:593` loop | `lib/stats.ts` | removes an N+1 on royalty decomposition | S |
| 7 | **Notification trim amortization**: drop per-write ZREMRANGEBYRANK; the read path already prunes by score — add rank-trim there or trim 1-in-8 writes | `lib/notifications.ts:219` | −1 command × every fan-out recipient (−~15% fan-out cost) | S |
| 8 | **Profile search index**: maintain `kismetart:profile-usernames` ZSET (member `username:addr`, lex-range search) or a bounded recent-profiles ZSET; stop SMEMBERS-ing the whole wallet index per search | `lib/profile.ts:183-213` | O(users)→O(log n + matches) per search | M |
| 9 | **Bound `collected` reads**: `ZRANGE 0..N` (e.g. 2000, rev) instead of `0..-1`; cursor-paginate the Collected tab by score | `lib/collected.ts:36` | caps heavy-collector reads | S |
| 10 | **`s-maxage=30` on GET /api/featured**; batch the 3 ZRANGEs stay as-is | `featured/route.ts` | 3 ZRANGEs → CDN/Next-cache absorbed | S |
| 11 | **Timeline meta-stitch narrowing**: for non-creator scopes, stitch meta on the post-filter page slice; keep pre-filter stitch only where creator-override feeds the filter | `timeline:310` | biggest MGET width ÷ ~10–50 on default/trending feeds | M |
| 12 | **Identity-chain request coalescing**: extend the React-cache pattern with a 30–60s in-process LRU for `getFidByAddress`/`getFarcasterProfileByAddress` results (they're already Redis-cached; this removes the serial RTTs on hot profiles) | `lib/farcasterProfile.ts` | SSR latency on profile/moment pages | S |
| 13 | **Namespace hygiene**: prefix `verify:*`, `img:total:*` with `kismetart:` (new writes; read both during TTL window) | 2 files | future-proofing | S |
| 14 | Fan-out ceiling: cap `fanoutToFollowers` at N most-recent followers (e.g. 5k) with a log line, until B2's queue lands | `notifications.ts:256` | converts the unbounded write storm into a bounded one | S |

## 5.3 What deliberately does NOT change

- **Keep** the Upstash SDK + auto-pipelining everywhere (any topology).
- **Keep** every Lua/MULTI/NX construct — the atomicity inventory (§1.4) is
  exactly right; none of it is a bottleneck.
- **Keep** the memoize tier and its TTLs (15m/60s) — at single-instance they're
  free consistency; revisit only at multi-pod (B4's shared cache handler).
- **Keep** write-side zset trims (trending/featured/airdrops/notif) — they are
  why only one unbounded-read cliff remains.
- **Keep** denormalized notification entries (self-contained feed = no join
  MGET on read — the right trade at cap 200).
- **Keep** the fail-open/fail-closed map exactly as documented (§1.3); every
  proposed move preserves it.
- **Do not** adopt Redis Cluster, RediSearch, RedisJSON, or hash-per-entity
  refactors — nothing in the workload needs them; per-entity string keys are
  what makes the chunked-MGET pattern work.

## 5.4 Alignment with the SCALING.md roadmap

| SCALING item | This review's contribution |
|---|---|
| B1 materialized feed | the per-scope capped-ZSET pattern is already proven in-repo (trending/latest/sale-ends/sale-free); extend it with a `created-mints` ZSET (fix #3) and per-creator index — the timeline's Redis side is then fully bounded |
| B2 notification queue | fan-out now quantified (6–13 cmds/follower); fixes #7/#14 shave it in place; QStash worker remains the architectural fix past ~5–10k-follower creators |
| B3 Postgres SoR | §4.1's Class A inventory = the exact table list; hybrid tiering (Option 4) is the intermediate step that already relieves latency + cost without re-platforming |
| B4 multi-pod cache | unchanged; local-Redis choice should expose SRH on the private network so future pods share it |

---

# Part VI — Rollout & measurement

**Measure first:**
1. ✅ **RTT — done 2026-07-11** via Coolify web terminal, 10 timed PINGs from
   inside the app container: **~4.4ms median steady-state (3.7–7.9ms), 162ms
   cold first-connection.** This resolved the topology question (Option 2;
   Options 2b/3/4 shelved). The `app/api/debug/redis-rtt` route on this
   branch re-measures on demand and also reports cardinalities/region/memory;
   **remove it once merged and run once.**
2. ✅ **Run rate / bandwidth / dataset — done 2026-07-11** from the console:
   ~50–70K cmds/day, ~20MB/day, 336KB data (backup-confirmed).
3. Still open (non-blocking): baseline cardinalities — one visit to the debug
   route, or the `DBSIZE`/`SCARD`/`ZCARD` block in the Upstash console CLI
   tab; log `created-mints` headroom (runbook §Verify prescribes rechecking
   periodically). Optional: the 20-line per-command counter proxy if a future
   regression ever needs per-keyspace attribution.

**Ops (done 2026-07-11):** PAYG budget cap set ($20, the console minimum —
Upstash stops the database at the cap, so this is runaway-bug/attack
protection with ~5–6× headroom over the run rate; recovery = raise the cap)
and **Daily Backup enabled** (was OFF; until then the only restore points
were the manual `k-backup1`, 335.74KB, and a 2-month-old export). Revisit a
fixed plan only past ~5M cmds/mo.

**Phase 1 — robustness (the plan):** #3 `created-mints` SMISMEMBER (kills the
one availability cliff), #5 gate single-flight, #6 `splitaddr` batch fix,
#9 bounded `collected` reads, #10 featured cache header, #13 namespace
hygiene + delete the `debug:ua-seen` leftover, #14 fan-out ceiling.

**Phase 2 — scale-shaped (with B1/B2 work, as traffic warrants):** listings
record split (#4), timeline stitch narrowing (#11), profile search index
(#8), `created-mints` ZSET index cutover, notification fan-out → queue past
~5k-follower creators.

**Optional (latency polish, ~4ms-scale wins):** #1 in-process rate limiter,
#2 session micro-cache, #7 notification trim amortization, #12 identity-chain
coalescing.

**Shelved:** local Redis + SRH hybrid (§5.1 Option 4) — revive only on
relocation out of US-East, an Upstash regression, or measured Redis-attributed
p99 pain.

**Exit criteria:** zero unbounded full-set reads on any per-request path
(created-mints, collected, profile search all bounded); fan-out capped;
baseline cardinalities recorded; debug route removed; budget cap + Daily
Backup verified on (✅).

---

_Method note: five parallel sub-agent sweeps covered (1) auth/session/limits/
locks/gates, (2) feeds/trending/featured/listings/stats/collected/sale-indexes,
(3) social graph/notifications/profiles/identity, (4) moments/moderation/
durable caches/media/splits/boot, (5) pass gate/airdrops/scout. Every `redis.*`
call site in the 57 importing modules is attributed above with `file:line`.
External pricing/limit claims were verified against upstash.com and the
canonical `upstash/docs` GitHub sources on 2026-07-11; per-plan throughput
throttles could not be verified from primary sources and are flagged._
