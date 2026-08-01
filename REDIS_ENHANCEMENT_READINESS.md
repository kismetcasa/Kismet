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

## 4. What I need from you

The code is fully mapped and I can act on it. What I cannot obtain from the
repository is **current runtime state**, and every remaining decision is gated on
it. In rough priority order:

### Tier 1 — blocking (the deferred triggers)

The review deferred six fixes behind **numeric triggers**. Nothing should ship
until we know which have fired. From the **Upstash console → CLI tab**:

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

If you'd rather not run these by hand, I can write an admin-gated diagnostics
route that reports all of it in one call — the 07-13 branch had exactly that
(`768b140`) and removed it after use; re-adding it temporarily is a clean
pattern and precedented.

### Tier 2 — needed to re-decide anything the measurements rejected

- **Current Upstash console Usage figures**: commands/day, read/write split,
  bandwidth/day, total data size, current month's cost.
- **Whether the `$20` budget cap and Daily Backup are still set** (both were
  turned on 07-13; a cap hit *stops the database*, so this is availability-
  relevant, not just billing).
- **A fresh RTT measurement** — 10 timed `PING`s from inside the app container
  via the Coolify web terminal. The 4.4ms figure is what shelved the topology
  work; if the box or the Upstash region moved, that conclusion reopens.

### Tier 3 — scope and constraint

- **Is the deployment still single-instance?** Enormous amount rests on this:
  the 15-min memoize TTLs, `redisHealth`'s module-scoped timestamp, the
  in-process caches, and the review's "free consistency at single-instance"
  reasoning. Any multi-pod plan changes the answer to roughly half the
  deferred items.
- **What problem are you actually trying to solve?** The honest read of the
  evidence is that this implementation is in good shape and **not currently
  cost- or latency-bound** — so "enhancement" could mean latency, cost,
  robustness/cliffs, or preparing for a specific growth event. These point at
  different fixes, and some are mutually exclusive. If there is a *symptom*
  (a slow page, a cost jump, an incident), that's more useful than a target.
- **Any Redis-attributed incidents since 2026-07-13** that aren't in the commit
  log.

### What I do *not* need

The keyspace inventory, call-site attribution, failure-policy map, and atomicity
inventory are all current and verified — `REDIS_IMPLEMENTATION_REVIEW.md` Parts
I–IV stand. No need to re-supply any of that.

---

## 5. Recommended sequencing

Independent of the numbers above, three items are safe now because they are
either doc-accuracy or exact-parity-with-an-existing-guard:

1. **Correct the `lib/redis.ts` comments** (§1.1–1.3). Zero runtime change;
   removes three false premises that future work would build on.
2. **Route `getCollectionsByArtist` through `mgetChunked`** (§2.1) — completes
   `40032d5`'s own intent on a path it missed; identical semantics.
3. **Chunk `getListingsBatch`** — same guard, same class, closes the unbounded
   seller-index MGET.

Everything else waits on Tier 1. That ordering is deliberate: it matches the
history's own standard of shipping only what has been validated as
zero-regression, and it avoids re-deciding measured-and-rejected items on stale
data.
