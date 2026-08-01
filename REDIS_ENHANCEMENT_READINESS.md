# Redis Enhancement Readiness — Re-validation & Input Brief

_Produced 2026-08-01. This is an **addendum** to `REDIS_IMPLEMENTATION_REVIEW.md`
(2026-07-13), not a replacement. That document remains the canonical keyspace
inventory and target design; this one records (a) what re-validation against the
current tree found, (b) three primary-source SDK findings that correct
load-bearing comments in `lib/redis.ts`, and (c) the exact inputs required before
any further enhancement can claim "no regressions."_

---

## 0. Method

- Read the full core layer line-by-line: `lib/redis.ts`, `lib/kv.ts`,
  `lib/redisRead.ts`, `lib/redisLock.ts`, `lib/redisHealth.ts`,
  `lib/ratelimit.ts`, `lib/memoCache.ts`, `lib/leaderLock.ts`,
  `lib/bestEffort.ts`, `lib/backgroundTasks.ts`, plus the call-site sweep across
  `lib/` and `app/` (~150 importing modules).
- **Unshallowed the clone.** The working copy was a shallow clone (304 commits,
  graft at `d0b705f`), which made every Redis file look like it was created in a
  single 2026-07-16 merge. After `git fetch --unshallow`: **2,268 commits**, and
  the true history resolves — `lib/redis.ts` has **17** commits back to
  2026-04-30, `lib/kv.ts` **55**, `lib/stats.ts` **43**; **128 distinct commits**
  touch the Redis core. Any prior analysis done on the shallow tree was reasoning
  from a truncated history.
- Verified the `@upstash/redis@1.38.0` auto-pipelining and retry internals
  against the **published tarball source**, not documentation or memory.

---

## 1. The three SDK findings (primary-source verified)

These matter because `lib/redis.ts` is the single most load-bearing comment block
in the Redis layer, and three of its claims are inaccurate. None is a live bug —
but each one invalidates reasoning that future enhancements would rest on.

### 1.1 `smembers` and `zrange` are **excluded** from auto-pipelining

`@upstash/redis` keeps an `EXCLUDE_COMMANDS` set that the auto-pipeline proxy
checks *before* anything else. Excluded commands return the direct, un-proxied
method and issue **their own HTTP request**:

```
scan, keys, flushdb, flushall, dbsize, hscan, hgetall, hkeys,
lrange, sscan, smembers, xrange, xrevrange, zscan, zrange, exec
```

`smembers` and `zrange` also appear in `READ_COMMANDS`, but the exclude check
wins — they are never batched.

**This is precisely inverted from where the codebase assumes batching helps.**
The excluded list is the set-and-zset read surface, which is exactly the
unbounded-growth keyspace the 07-13 review flagged. Concretely, these
`Promise.all` sites do **not** collapse into one round trip:

| Site | Commands | Actual HTTP requests |
|---|---|---|
| `lib/kv.ts:422` `searchCollections` | 3× `smembers` | **3** (then 1 pipelined `mgetChunked`) |
| `lib/notifications.ts:331-334` | 1× `zrange` + 2× `smembers` | **3** |
| `lib/showcase.ts:81-83` | 3× `zrange` | **3** |
| `lib/stats.ts:1053-54`, `1078-79` | 2× `zrange` each | **2** each |
| `lib/profile.ts:184` `searchProfiles` | `smembers` + 2 memoized sets | **1–3** |

They fire concurrently, so wall-clock stays ≈1 RTT (≈4.4ms measured) rather than
N×RTT — the practical cost today is HTTP/TLS overhead and request count, not user
-visible latency. **The correctness issue is the mental model**, which is
currently documented as "auto-pipelining collapses this for free" in several
places where it does not.

What *is* correctly batched (verified): `mget`, `smismember`, `get`, `set`,
`sadd`, `zadd`, `eval`. So `mgetChunked`'s "chunks collapse into ONE round trip"
claim is **true**, and `getCreatedMintsMembership`'s chunked-`SMISMEMBER` claim is
**true**. `scanCreatedMints` uses `sscan` (excluded) but is inherently sequential,
so its documented "~1 round trip per 1000 members" is also **true**.

### 1.2 Reads and writes go into **separate** pipelines

The executor maintains `activeReadPipeline` and `activeWritePipeline`
independently. A same-tick mix of reads and writes therefore produces **two**
HTTP requests, not one. Each also auto-flushes at `MAX_PIPELINE_SIZE = 1000`
commands.

This softens commit `a89e6ca`'s claim that auto-pipelining "collapses the
notification/airdrop fan-outs into ONE REST round trip." Pure-write fan-outs do
collapse (correct, and the win is real). Mixed read/write batches cost two.

### 1.3 `eval` **is** auto-pipelined, and retry re-sends the whole batch

`lib/redis.ts:33-35` states that `multi()`/`eval` are "atomic and unaffected."
Half right:

- **Atomic — yes.** A Lua script is atomic on the server regardless of transport.
- **Unaffected — no.** `eval` is on the Pipeline class and is *not* in
  `READ_COMMANDS`, so it is batched into the **write** pipeline. (`multi()` is
  genuinely separate — that half of the comment is correct.)

This interacts with the retry policy. Retry is implemented at the
**whole-HTTP-request** level: on a `fetch` throw the entire serialized body is
re-POSTed. So one network blip can re-execute **every write in the batch** — up
to 1000 commands, including the rate-limit `EVAL`, the quota Lua, and the
platform-tx ledger Lua. The 07-13 reasoning that "fewer retries = fewer duplicate
writes" holds, but the blast radius per retry is a **batch**, not a command.

One further nuance worth recording: the retry loop only catches `fetch`
**throwing** (connection/DNS/abort). A non-`ok` HTTP response — including a 5xx
from Upstash — throws `UpstashError` immediately with **no retry**. So
`retries: 2` covers transport failures only, not server-side errors.

---

## 2. Drift since the 2026-07-13 review

The review's shipped/rejected/deferred dispositions still hold. Two items have
drifted since, both from commit `40032d5` (2026-07-27, search work):

1. **`mgetChunked` was applied asymmetrically.** `searchCollections`
   (`lib/kv.ts:429`) and `searchProfiles` (`lib/profile.ts:195,220`) were routed
   through it. But `getCollectionsByArtist` (`lib/kv.ts:383`) reads the **same
   full curated-collections set** through a raw unchunked
   `redis.mget(...keys)` — same 10MB-cap exposure the commit set out to close,
   on a path hit by `/api/collections` (two call sites). Same class:
   `getListingsBatch` (`lib/listings.ts:142`) is unchunked and is fed by an
   unbounded `smembers(keyBySeller)` — this is the review's own deferred
   "`listings:seller` bound" item, still open.

2. **A new full-catalog scan entered the search path.** `scanCreatedMints` +
   `getMomentMetaBatch` now run per non-address search query. It is bounded and
   logs its truncation (good, and deliberate), but it moved `created-mints` from
   "one hourly sitemap consumer" to "a user-facing hot path" — which changes the
   trigger conditions the review attached to that key family.

Everything else re-verified as documented: `retry`/`enableAutoPipelining` present,
featured trims + `MAX_FEATURED` present, `SMISMEMBER` membership present,
fan-out concurrency chunking + `[notifications] large fan-out` warn present,
`/api/debug/redis-rtt` correctly removed, `zrange 0,-1` still on `collected`,
`sale-free`, `showcase`, and the stats royalty zsets as the review's deferred
table says.

---

## 2.5 Measured state, 2026-08-01 (console figures supplied)

| Metric | 2026-07-13 | 2026-08-01 | Δ |
|---|---|---|---|
| Commands/day | ~50–70K | **~170K** (215/160/155/150K Tue–Fri) | **~3×** |
| Bandwidth/day | ~20MB | **~55–92MB** | **~3–4×** |
| Data size | 336KB | **641KB** | **1.9×** |
| Keyspace | not recorded | **~4,000 keys** (flat/slightly declining) | — |
| Month-to-date | 579K cmds / $1.16 @ day 13 | **3.4M cmds / $6.88** (full July) | — |
| Region / plan | us-east-1, PAYG, Global | unchanged | — |

**The step change was mid-July, not the 07-27 search commit.** July 1–13 ran at
45K/day (579K over 13 days); the remaining 18 days implies **157K/day**. The
0727 search work is MGET/SSCAN-shaped, and MGET reads near-zero on the Top
Commands chart — so it is not the driver. The increase is GET-shaped, which is
what per-request auth/identity/meta reads look like when traffic grows.
Attribution beyond that is **not possible from console data** (see §4.1).

### 2.5.1 The finding that actually matters: cap headroom collapsed

At 170K commands/day the August projection is **~5.3M commands ≈ $10.50/mo**
(PAYG, $0.2/100K), against the **$20 budget cap set on 07-13**. Upstash **stops
the database** at the cap.

- 07-13, at ~$3–4/mo run rate, the review recorded "~5–6× headroom."
- 08-01, at ~$10.50/mo projected, headroom is **~1.9×**.

This degraded silently — no code changed, no alert fired, the cap did its job by
existing. **Any 2× event now reaches a hard stop**: a launch, a viral moment, a
bot, or a retry loop. And per §1.3, one retried pipeline re-sends up to 1000
commands, so a network-flaky window is itself a command-count amplifier.

This is an **availability** risk, not a cost one. $10/mo is immaterial; a stopped
database is a total outage. It is also the one thing on this list that can be
fixed in a single console action, and it is the only item here I would treat as
time-sensitive.

### 2.5.2 What the command mix says about where the wins are

The Top Commands chart shows **GET dominating everything else by roughly 10:1**.
MGET, EVAL, INCR, EXPIRE, MULTI, EXEC, DEL, HGETALL, RENAME are all flat near
zero at that axis. (Careful: "flat at a 100K axis" bounds them below ~10K — it
does not prove they are negligible.)

That re-ranks the fix table meaningfully. The MGET chunking and pipelining work —
the entire optimization arc from `a89e6ca` through `40032d5` — operates on a slice
of traffic that barely registers. **The command budget is spent on point GETs**,
and the only fixes that touch point GETs are the ones the 07-13 review rejected
on cost/latency grounds:

| Fix | 07-13 disposition | Status under 08-01 data |
|---|---|---|
| #2 session micro-cache | rejected ("no problem at 4.4ms/$3–4") | **Reopens.** 1 GET/authed request is the single highest-frequency GET in the app. |
| #1 in-process rate limiter | rejected, same basis | Weak — EVAL reads near-zero. Lower value than the review assumed. |
| #12 identity-chain coalescing | rejected, same basis | Reopens on command-count grounds (it was rejected on latency grounds). |
| #5 gate-config collapse | rejected as cosmetic | **Stays rejected** — verified `getGateConfig` has a 15s in-process cache (`lib/gate.ts:44`); the 9-GET burst does not occur. |

The rejections were argued from **cost and latency**. Both are still fine in
absolute terms. What changed is **cap proximity**, which is a different argument
the review never made — so these are not "the review was wrong," they are "the
premise moved."

### 2.5.3 Two anomalies worth explaining before acting

1. **Misses exceed hits at every traffic spike** (misses 15–21/sec vs hits
   0–8/sec). A keyspace of only ~4,000 keys serving a miss-dominated read
   pattern says a large share of GETs are for keys that do not exist. That is
   consistent with the negative-cache/sentinel design (`smartWalletCache`,
   `ensCache`, `farcasterProfile`) — but it could equally be an un-cached
   lookup repeatedly missing. Worth attributing, because a miss is a billed
   command that produced nothing.

2. **A discontinuity at Jul 31 ~19:54–20:00** — command counters reset to zero
   and write p99 stepped from ~2.1ms to ~5.3ms afterward. This reads as a
   deploy/restart (counter reset is the tell), and the p99 step is plausibly
   low-volume noise. **Confirm it was a deploy**; if it was not, it is an
   incident that needs its own look. Note also that Saturday reading ~0 on the
   daily charts is just the UTC day having barely started — not an outage.

Server-side service time is healthy and not a concern: read p99 ≈ 0.1ms, write
mean ≈ 0.7ms. The 4.4ms figure from 07-13 is network RTT; these are disjoint
measurements and the RTT re-measure is still outstanding.

---

## 3. What the commit history actually tells us

The 128-commit story has a consistent shape, and it is the strongest available
guide to what "no regressions" means here.

**The arc.** `@vercel/kv` → `@upstash/redis` (2026-04-24, `cebdcf6`) → security/
rate-limiting hardening (04-30) → build-safety softening of env guards (05-07,
`e784536`) → post-Vercel cleanup + MGET batching (05-17, `21e7bd0`) →
auto-pipelining (06-06, `a89e6ca`) → the downtime-driver batch (07-01, `83767c1`)
→ retry cap / fail-fast (07-02, `1bf7b1b`) → the five-agent review + SMISMEMBER
cliff fix (07-13, PR #562) → chunked MGETs in search (07-27, `40032d5`).

**Four invariants the history defends repeatedly.** Every one of these was
established by a specific incident or audit, and breaking any of them is what a
regression would look like:

1. **Failure-policy asymmetry is deliberate and per-call-site.** `safeRead` vs
   `strictRead`; `getTrackedCollections` fails *open* while
   `getTrackedCollectionsStrict` fails *closed* because the stats rebuild does a
   destructive overwrite; `getCreatedMintsMembership` deliberately has **no**
   try/catch so the timeline skips the filter rather than blanking the feed;
   `getFreeMoments` has two consumers with opposite semantics. These read like
   inconsistencies and are not. `1bf7b1b` explicitly declined a blanket
   fail-closed on quotas as an availability regression.

2. **Unbounded reads are the recurring failure class.** `83767c1` (featured
   zsets), PR #562 (`created-mints` SMEMBERS), `40032d5` (search MGETs) are three
   passes at the same bug shape. The 10MB Upstash request/response cap is the
   cliff each was avoiding.

3. **Write-side trims are what keep reads bounded** — trending/featured/notif/
   sale-index caps. The review explicitly lists these under "what does not
   change."

4. **Claims get validated before they get shipped.** §5.2.1 falsified one of its
   own findings (`splitaddr` N+1) and rejected five more on measurement. `1bf7b1b`
   says "implemented only the clearly-correct, zero-regression items."

**The methodological warning.** The 07-13 review's dispositions rest on measured
numbers — 4.4ms RTT, 336KB dataset, ~50–70K commands/day, $1.16/mo. Those
measurements are what rejected fixes #1, #2, #7, #10, #12 and shelved the entire
topology change. **Those numbers are now ~3 weeks old.** Re-deciding anything on
the strength of a stale measurement is the single most likely way to introduce a
regression here — either by "optimizing" something the data says is free, or by
leaving a deferred trigger unchecked after it has silently fired.

---

## 4. What is still missing

Tier 2 of the original brief (usage, cost, storage, region, plan) is **answered**
by the 08-01 console figures in §2.5. Four gaps remain, and they are now the only
things standing between here and a defensible enhancement plan.

### 4.1 Command attribution — the biggest gap, and it needs code

The console reports command *types*, never *call sites*. We know GET is ~90% of
traffic; we cannot tell whether that is session validation, moment-meta reads,
identity resolution, or a poll loop. Every remaining prioritization decision
depends on that split, and **no amount of console data will produce it.**

Two ways to get it, in order of preference:

- **A counting wrapper around the client** (~30 lines): a dev/staging-gated proxy
  over `redis` that tallies `{command, label}` into an in-process map, exposed on
  an admin-gated route. Labels already exist at most call sites via `safeRead`/
  `strictRead`. Zero production behaviour change if flag-gated, and it answers
  the question in a day of real traffic.
- **A one-off sampling window**: log every `redis.get` key *prefix* (never the
  full key — addresses and tokens are PII/secret) at 1-in-N sampling for an hour.
  Cruder, faster, no new surface.

I would build the first. It is also the artifact that makes the *next* review
cheap instead of another five-agent sweep.

### 4.2 The cardinality block — still outstanding

Keyspace ≈ 4,000 keys is a useful bound (it means no key family has exploded in
*count*), but the deferred triggers are on **member counts inside single keys**,
which a keyspace total cannot show. From the **Upstash console → CLI tab**:

```
DBSIZE
SCARD kismetart:created-mints
SCARD kismetart:profiles
SCARD kismetart:collections
SCARD kismetart:created-collections
ZCARD kismetart:trending
ZCARD kismetart:sale-ends
ZCARD kismetart:sale-free
ZCARD kismetart:featured
```

Against the trigger table: `created-mints` (cliff at ~200k), `profiles` > 5,000
→ search index; tracked collections > 100 → timeline stitch narrowing.

Plus the two per-entity ones, which need a worst-case sample rather than a global
count — the largest few of each:
- `ZCARD kismetart:collected:{address}` for your heaviest collectors (trigger:
  >1,000)
- `SCARD kismetart:listings:seller:{address}` for your heaviest sellers
  (trigger: >500)
- active listings total (trigger: >300 → listings record split)

The diagnostics route from `768b140` (removed after the 07-13 measurement) is the
precedented way to collect all of this in one call, and it composes with the
counter in §4.1 — one temporary admin surface, both answers.

### 4.3 Operational confirmations

- **Is the `$20` cap still set, and is there an alert below it?** Per §2.5.1 this
  is now the sharpest edge in the system. A cap with no alert underneath it is a
  trap: the first signal is the outage.
- **Is Daily Backup still enabled?** (On as of 07-13.) Data size nearly doubled;
  Class A state — signed Seaport orders, the pass ledger, splits — is
  irreplaceable.
- **Was Jul 31 ~19:54 a deploy?** (§2.5.3.)
- **A fresh RTT measurement** — 10 timed `PING`s from inside the app container via
  the Coolify web terminal. Still outstanding; the console's service-time numbers
  measure something different (server-side processing, not network).

### 4.4 Scope and intent

- **Is the deployment still single-instance?** A great deal rests on this: the
  15-min memoize TTLs, `redisHealth`'s module-scoped timestamp, every in-process
  cache, and the review's "free consistency at single-instance" reasoning. A
  multi-pod plan changes the answer to roughly half the deferred items — and
  would make the §2.5.2 in-process caching fixes *worse*, not better.
- **What drove the mid-July 3×?** If you know of a launch, a campaign, or a
  traffic source that changed around Jul 14–20, that single fact would save the
  attribution work in §4.1. Organic growth and a runaway loop look identical on
  these charts and call for opposite responses.
- **Any Redis-attributed incidents since 07-13** not visible in the commit log.

### What I do *not* need

The keyspace inventory, call-site attribution, failure-policy map, and atomicity
inventory are current and verified — `REDIS_IMPLEMENTATION_REVIEW.md` Parts I–IV
stand. No need to re-supply any of that.

---

## 5. Recommended sequencing

**Now, no data required.**

0. **Raise the budget cap and add an alert beneath it** (§2.5.1). Console-only,
   no code. This is the one time-sensitive item on the list.

**Now, code, safe on current evidence** — each is doc-accuracy or exact parity
with a guard that already exists elsewhere in the tree:

1. **Correct the `lib/redis.ts` comments** (§1.1–1.3). Zero runtime change;
   removes three false premises that future work would build on.
2. **Route `getCollectionsByArtist` through `mgetChunked`** (§2.1) — completes
   `40032d5`'s own intent on a path it missed; identical semantics.
3. **Chunk `getListingsBatch`** — same guard, same class, closes the unbounded
   seller-index MGET.

**Next, to earn the right to do anything else:**

4. **Build the command counter** (§4.1) + the cardinality block (§4.2). Until GET
   is attributed, any work aimed at command volume is guesswork — and §2.5.2
   shows command volume is now the axis that matters.

**Then, and only then:** re-open #2/#12 with attribution in hand, and re-check
the deferred trigger table against real cardinalities.

This ordering is deliberate. It matches the history's own standard — ship only
what has been validated as zero-regression — and it specifically avoids
re-deciding the 07-13 rejections on *inferred* attribution, which is exactly the
mistake the 07-13 review avoided by falsifying its own `splitaddr` finding
rather than trusting the sweep.
