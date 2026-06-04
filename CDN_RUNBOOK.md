# Kismet — CDN Runbook: fronting `/api/img` (+ cacheable GETs)

Reproducible procedure for the highest-leverage infra change in
`SCALING_AUDIT.md §10.1` / `REMEDIATION_PLAYBOOK.md §B5`. Those docs hold the
**verdict**; this holds the **how**. The origin is already CDN-ready — this is
Cloudflare configuration + verification, not a code change.

## Why
`/api/img` streams up to 2 GB of immutable, content-addressed media through the
single Oracle box on every view (`app/api/img/route.ts:13`). A CDN turns
repeat/popular views into edge hits: faster gif/video render for users, and the
control for the otherwise-unbounded media egress that a request-count rate limit
can't bound (Range streaming).

## The origin is already correct (no code change)
- **Immutable + content-addressed:** success returns `Cache-Control: public,
  max-age=31536000, immutable` over `?u=ar://<txid>` — a deterministic key whose
  bytes never change (`app/api/img/route.ts:102`). Never needs revalidation.
- **Errors can't poison the cache:** 502 + 413 set `Cache-Control: no-store`
  (`app/api/img/route.ts:92,97`).
- **Range/video:** forwards `Range`, returns 206 + `Accept-Ranges` /
  `Content-Range` (`app/api/img/route.ts:82,108-111`).
- **Rate-limiting survives behind the CDN:** `cf-connecting-ip` is honored
  (`lib/ratelimit.ts:9`), so per-IP limits read the real client, not Cloudflare.
- **Feed GETs already share-cacheable:** viewer-independent `/api/timeline`
  (trending/featured/default) and `/api/moments` emit
  `public, s-maxage=30, stale-while-revalidate=…`; viewer-dependent timeline
  variants emit `private, no-store` (`app/api/timeline/route.ts:457`).

## Cloudflare configuration (the actual change)

### 1. Cache Rule for `/api/img` — CRITICAL
Cloudflare does **not** cache `/api/*` or query-string URLs by default, so the
immutable header alone does nothing until a Cache Rule makes the path eligible.

- **When:** `URI Path equals /api/img`
- **Then:** *Eligible for cache* = ON; *Edge TTL* = **Respect origin** (honors the
  1-year immutable header).
- **Cache key:** keep the query string (default) — `?u=` is the content identity,
  so each asset caches separately. Exclude cookies/headers from the key (there is
  no per-user variance).

### 2. Feed GETs (optional companion rule)
`URI Path equals /api/timeline` or `/api/moments` → *Respect origin* (honors
`s-maxage=30` + SWR). Leave the viewer-dependent timeline variants alone — the
origin already marks them `no-store` and Cloudflare obeys it.

### 3. Next static + image optimizer
Cache `/_next/static/*` (Next sets immutable long-cache automatically) and
`/_next/image` (emits its own 31-day TTL, `next.config.mjs:80`) for full image
offload.

## Object-size reality (the one limit)
Cloudflare caches objects up to **512 MB** (Free/Pro/Business), **5 GB**
(Enterprise).
- Kismet's own uploads are capped at **420 MB** (`components/MintForm.tsx:304`,
  `components/MomentDetailView.tsx:182`) → **every Kismet-minted image + video
  fits → near-total offload on any plan.**
- The only bypass: a rare tail of >512 MB legacy/externally-sourced media
  (`/api/img` allows up to 2 GB). Those stream through to origin uncached —
  acceptable. Revisit with Enterprise (5 GB) or a media path (Cloudflare Stream /
  R2 / sub-512 MB renditions) only if that tail proves heavy in egress metrics.

## Range / video behavior
Cloudflare caches the **full object**, then serves byte-range slices from cache.
On the first Range request for an uncached asset it fetches the full object from
origin (the route returns a full `200` when no `Range` is sent), caches it, and
serves the range. Seek/resume therefore works through the edge with one origin
full-fetch per asset.

## Purge
- **`/api/img` is immutable → no scheduled purge.** Purge a single URL only to
  evict a rare poisoned asset (a flaky gateway can return `200` with a bad body,
  which then caches immutably): Cloudflare → *Purge by URL*
  `https://<host>/api/img?u=ar://<txid>`.
- **ISR/feed pages:** `revalidateTag` / `revalidatePath` do **not** purge the CDN
  (`REMEDIATION_PLAYBOOK.md` §A7). The feed GETs use a short `s-maxage` (30 s) so
  staleness self-heals; if on-demand revalidation is added later, wire a CDN purge
  for **both** the HTML and RSC variants.

## Verify (post-deploy)
```sh
HOST=https://kismet.art            # your host
TX=<ar-txid-of-a-known-image>
VID=<ar-txid-of-a-known-video>

# 1. immutable header, and MISS → HIT on the second fetch
curl -sI "$HOST/api/img?u=ar://$TX" | grep -iE 'cache-control|cf-cache-status'
curl -sI "$HOST/api/img?u=ar://$TX" | grep -i  'cf-cache-status'   # expect: HIT

# 2. Range works through the edge
curl -sI -H 'Range: bytes=0-1023' "$HOST/api/img?u=ar://$VID" \
  | grep -iE 'content-range|cf-cache-status'                       # expect: 206 + Content-Range

# 3. errors are NOT cached
curl -sI "$HOST/api/img?u=ar://deadbeef" | grep -i 'cache-control' # expect: no-store (502)
```
Pass criteria: `cf-cache-status: HIT` on the 2nd image fetch · `immutable`
present · Range → `206` with `Content-Range` · error path `no-store`.

## What NOT to do
- Don't add a request-count rate limit to `/api/img` — Range streaming behind
  carrier-grade NAT would 429 real viewers; the per-request size cap + the CDN
  are the controls (`SCALING_AUDIT.md §9`).
- Don't cache viewer-dependent feeds — they're `no-store` for a reason.
- Don't strip the query string from the `/api/img` cache key — `?u=` *is* the
  asset identity.
