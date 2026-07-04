# Video Playback RCA — mobile/miniapp failures (2026-07-03)

Root-cause analysis for two reported video moments, validated end-to-end against
code, live metadata, and live delivery probes. All probe outputs referenced here
were captured 2026-07-03 from a residential US connection (macOS, curl/ffprobe).

- **Moment A** — Dúo Dø, *Mi Amor por Ti — EPP*: `0xbc87bdbd5dbd9253f37237911c50717de4dec94f/1`
  - Reported: plays as intended on desktop; never plays on mobile or in the Mini App — feed **or** detail.
- **Moment B** — dwn2erth, *gargoyle cat*: `0x5f98221632ca450bab4f2f566ca610e4cb1f9d60/1`
  - Reported: never plays inline (feed card) on any platform; plays from the moment detail page.

Verdict in one line each:

- **A is a delivery-layer failure**: arweave.net now serves this txid through a
  302 sandbox redirect whose final response carries **no byte-range support and
  no Content-Length**; `/api/img` passes that degradation through, and iOS
  (AVFoundation) refuses any media source that can't answer `Range` probes with
  `206`. Desktop plays because desktop never uses the proxy and tolerates
  progressive `200` streams. The file itself is trivial: 35 s, 720×576 H.264/AAC,
  faststart (`moov` at byte 36).
- **B is a classification-layer failure**: the inprocess `/timeline` index row
  for the token has `content: null`, so the feed classifies the moment as an
  image and **never mounts a `<video>` element**; inprocess `/moment` returns
  `content.mime: "video/mp4"`, so the detail page classifies it as video and
  plays. Duration is irrelevant — no duration gate exists anywhere in feed
  playback.

---

## 1. Architecture recap (what decides whether a video plays)

Two independent layers must both succeed:

1. **Classification** — `resolveMomentMedia()` → `isVideoMoment()`
   (`lib/media/isVideo.ts:20-28`): video ⇔ `content.mime` starts with `video/`
   **or** `animation_url` has a known video extension. Kismet's MintForm writes
   neither a `content` field nor an extension (`components/MintForm.tsx:1134-1140`;
   `animation_url` is an extensionless `ar://txid`), so classification for every
   extensionless mint depends on the mime the **inprocess indexer** attaches.
   The feed reads inprocess `/timeline` (metadata inlined per collection,
   `app/api/timeline/route.ts:50-66`); the detail page reads inprocess `/moment`
   (`lib/momentDetail.ts:66-110`). Two upstream code paths → two copies that can
   disagree per token.

2. **Delivery** — `videoGatewayUrls()` (`lib/media/gateway.ts:60-66`):
   - Desktop top-level browsers: direct gateway only — `[https://arweave.net/<txid>]`
     (single-entry pool since the 2026-05/06 prunes, `lib/arweave/gateways.ts:19-21`).
   - iOS Safari / Chrome-iOS / any WebKit-only webview / any iframe (Mini App on
     web and in-app): **proxy first** — `[/api/img?u=ar://…, https://arweave.net/…]`.
   - The walk advances **only on a hard `error` event**
     (`components/InlineVideo.tsx:249-258`); a stalled source never advances.
     `MomentVideo` latches `videoFailed` after the walk exhausts and removes the
     `<video>`, leaving the poster `<img>` (`components/MomentVideo.tsx:104-110`).

Feed playback is coordinated (`lib/media/feedPlayback.ts`): mobile/iframe cap of
3 playing / 5 buffering, desktop uncapped. **No gate anywhere consults duration**;
`kismet_duration_sec` only selects loop/resume behavior
(`components/InlineVideo.tsx:16,74-77,294`).

---

## 2. Validated findings (evidence per claim)

| # | Finding | Status | Evidence |
|---|---|---|---|
| 1 | Moment B's feed copy and detail copy of metadata disagree: `/timeline` row has `content: null`; `/moment` has `content.mime: "video/mp4"` (same `animation_url` `ar://TQb6…`) | **VALIDATED** | Live JSON from both endpoints, 2026-07-03 |
| 2 | With `content: null` + extensionless `ar://`, the feed classifies B as an image → poster `<img>` only, no `<video>` ever mounts, all platforms | **VALIDATED** | `lib/media/isVideo.ts:20-28`, `lib/media/resolveMomentMedia.ts:84-89`, `components/MomentCard.tsx:444-457` |
| 3 | No duration/length gate exists in feed playback ("too long for feed" is impossible) | **VALIDATED** | Full read of `InlineVideo.tsx` / `feedPlayback.ts`; duration only drives `loop` + preload tier |
| 4 | Moment A is classified video in **both** copies (`content.mime: video/mp4` present in `/timeline` and `/moment`) — classification is not A's problem | **VALIDATED** | Live JSON from both endpoints |
| 5 | Moment A's file is light and well-formed: 35.008 s, 720×576, H.264 + AAC (+ one NLE timecode data track), **faststart** (`moov` @ 36, `mdat` @ 40369) | **VALIDATED** | `ffprobe` + first-128KB atom scan through the redirect |
| 6 | arweave.net answers `GET/HEAD arweave.net/<A-txid>` with **302** → `https://7evxmvvlenk56gky…arweave.net/<txid>` (sandbox subdomain). B's txid 302s identically | **VALIDATED** | `curl -sI` both txids |
| 7 | The final (sandbox) response advertises **no `Accept-Ranges`, no `Content-Length`** (HyperBEAM/ANS-104 signed-response stack; `signature-input: …ans104…`, original `File-Name: "Glitch - Token Support.mp4"`) | **VALIDATED** | `curl -sIL` final-hop headers |
| 8 | `/api/img?u=ar://<A-txid>` answers a **`Range: bytes=0-1` request with `200`** — no `Content-Range`, no `Accept-Ranges`, no `Content-Length` | **VALIDATED** | Live probe of production `/api/img` |
| 9 | iOS/AVFoundation requires servers to answer byte-range requests with `206` for progressive `<video>`; a `200` to its `bytes=0-1` probe ⇒ playback refused. Hence every proxy-first surface fails A deterministically, feed and detail | **VALIDATED** (mechanism; Apple-documented behavior) + consistent with all observed surfaces | Probe #8 + user reports + screenshot evidence |
| 10 | In the desktop Mini App session, A's detail showed the poster `<img>` (`ar://zwQGoi…` = `metadata.image`) with the `<video>` element absent ⇒ `videoFailed` latched (both candidates errored) | **VALIDATED** | DevTools "Selected Element" screenshot; `MomentVideo.tsx:104-110` renders exactly that fallback |
| 11 | `/api/img` accepts a gateway **HTML fallback page as a "win"** and stamps it `Cache-Control: public, max-age=31536000, immutable` (observed: bogus txid → `200 text/html` + immutable) | **VALIDATED** | Live probe; `app/api/img/route.ts:94-99` (any 2xx wins), `:226-231` (immutable headers unconditional) |
| 12 | No CDN currently fronts kismet.art `/api/img` (CDN_RUNBOOK not yet applied); arweave.net itself is fronted by CDN77 | **VALIDATED** | Response headers (no CDN markers on kismet.art; `server: CDN77-Turbo` on arweave.net) |
| 13 | Neither moment was minted through Kismet's MintForm optimizer (no `kismet_thumbhash`, no `kismet_duration_sec`, inprocess-decorated metadata) — so mint-time faststart/duration/mime writes could not have protected them | **VALIDATED** (strong inference) | Metadata shape vs `MintForm.tsx:1134-1140` outputs |
| 14 | The Cloudflare Stream `401`s in the Mini App console belong to the Farcaster **host page** (farcaster.xyz serves its own videos via `customer-*.cloudflarestream.com`), not to the Kismet moment | **VALIDATED** | A's metadata contains only `ar://` URLs; console context includes host-page errors (`wss://ws.farcaster.xyz`, `wallet.farcaster.xyz`) |

### Refuted hypotheses (kept for the record)

| Hypothesis | Verdict | Refuting evidence |
|---|---|---|
| "Duodo's video is too heavy for mobile" (user H1) | **REFUTED** | 35 s SD file, faststart; iPhones decode far heavier media |
| "Dwn's video is too long to play in feed" (user H2) | **REFUTED** | No duration gate in code (finding 3); real cause is classification (findings 1-2) |
| A fails because file >100MB skipped faststart remux / >2GB proxy cap | **REFUTED** | File is small and already faststart (finding 5) |
| A's source is Cloudflare Stream signed HLS (investigator error, from the Mini App console) | **REFUTED** | Finding 14; A is a plain `ar://` mp4 |
| A's feed/detail metadata copies diverge like B's | **REFUTED** | Finding 4 |

### Open items (each with the probe that closes it)

1. **Desktop Mini App (Chrome-in-iframe) exact failing hop for A.** iOS's refusal
   is proven; Chromium tolerates progressive `200`s, yet the miniapp session
   showed `videoFailed`. Two candidates: (a) the no-length chunked proxy stream
   erroring mid-flight in the embedded context; (b) iframe `autoplay`
   permissions-policy denying `play()`. Close with, in the miniapp console:
   `document.permissionsPolicy?.allowsFeature('autoplay')` and the Network tab
   status for `/api/img?u=ar://-St2…`.
2. **Blast radius: are *all* ar:// videos currently broken on iOS?** Both
   affected txids 302-redirect (finding 6). If the sandbox/CDN77 stack answers
   range probes with `200` for *every* data item (possibly only when
   edge-cold), then **every Kismet video moment is currently unplayable on
   iOS/miniapp**, and these two reports are the visible edge of a platform-wide
   outage caused by the gateway-side serving change. Close with the same probe
   battery against a known-"working" video's txid + a 30-second iPhone spot
   check of any other video moment.
3. **Does B's detail page actually play on iPhone?** The model predicts **no**
   (same 302'd txid, same range problem) even though desktop detail plays.
   Close with an iPhone Safari visit to the moment page.
4. **inprocess-side question**: why B's `/timeline` row has `content: null`
   while `/moment` enriches mime (indexer timing vs. never-backfilled row).
   Upstream owns the answer; Kismet's fix (F3) removes the dependency either way.

---

## 3. Why each bug happened (causal chain + regression attribution)

Git history note: the repo clone is shallow (cut at 2026-06-06, PR #422 era).
Within the visible window:

- The current video architecture — `InlineVideo`, `feedPlayback`,
  `videoGatewayUrls` proxy-first branch, `/api/img` Range forwarding — all
  predate or land at the boundary (PR #422, merged 2026-06-06). Both moments
  were minted after it (A: 2026-06-25, B: 2026-06-26). **No Kismet commit in the
  visible window changed video behavior between "worked" and "broken".**
- `MintForm.tsx` has **never** written `content.mime` in the visible history
  (`git log -S mime -- components/MintForm.tsx` → empty): a latent gap since
  inception, not a regression.
- Gateway pool shrank to a single entry via the 2026-05/06 prunes
  (`0ce38ee`, `8cf00c9` + earlier), removing all redundancy from the
  client-side "walk". Deliberate (dead gateways), but it makes any arweave.net
  behavior change total.

### Moment A — regression is environmental, amplified by a designed-in assumption

1. arweave.net's serving stack now handles this txid (an ANS-104 data item)
   with a **302 to a sandboxed subdomain** whose responses (CDN77 +
   HyperBEAM-signed) carry **no `Accept-Ranges`/`Content-Length`** and answer
   ranged requests with `200` (findings 6-8). This is a change **outside the
   repo** — nothing in Kismet's history touched it.
2. `/api/img` was built as a **verbatim pass-through**: it forwards `Range`,
   passes through whatever status/headers the winning gateway returns, and its
   own comment records the fatal assumption — *"gateways that don't [honor
   ranges] fall back to 200 + full body and the browser will discard bytes"*
   (`app/api/img/route.ts:94-99`). True for Chromium; **false for iOS**, where a
   `200` to the range probe means "server can't do ranges" ⇒ refuse to play.
   The server-side `fetch` also follows the 302 silently, so the degradation is
   invisible in our own headers.
3. Every WebKit/iframe surface tries the proxy first and hits finding 8 ⇒ hard
   error; the fallback (direct arweave.net) presents the **same rangeless
   sandbox response** to iOS ⇒ second refusal ⇒ `videoFailed`, poster forever
   — feed and detail alike, which is exactly the report.
4. Desktop top-level skips the proxy, follows the 302, and progressive-plays
   the `200` stream (faststart + 35 s ⇒ instant) — "plays as intended".

### Moment B — upstream data gap meets a mime-dependent classifier

1. The token (minted outside Kismet's MintForm) has an extensionless
   `animation_url` and its **inprocess `/timeline` index row carries
   `content: null`**, while `/moment` computes `content.mime: video/mp4` on
   demand (finding 1).
2. `isVideoMoment()` has no third signal — mime or extension, else "not video"
   (`lib/media/isVideo.ts`). The feed therefore renders the moment as a still
   image on every platform; the detail page, reading the enriched copy, renders
   a playable video. Neither surface is "wrong" given its input; the system has
   **no defense against metadata-copy divergence** for extensionless media.
3. Not a commit-level regression: the classifier and the two-endpoint metadata
   split predate the visible window. It is a latent design gap that any
   mime-less upstream row exposes.

---

## 4. Fix plan (with prevention per item)

### F1 — `/api/img`: own the byte-range contract (fixes A on all mobile/miniapp surfaces; primary fix)

File: `app/api/img/route.ts`.

- Resolve gateway redirects **manually** (`redirect: 'manual'`, walk `Location`
  up to a small hop cap) so the ranged request is guaranteed to be issued
  against the final host — never dropped or reinterpreted mid-chain.
- If the client sent `Range` and the final upstream still answers `200`,
  **synthesize the `206`**: skip `start` bytes on the stream, cap at
  `end−start+1`, emit `Content-Range: bytes start-end/<total|*>`. (The
  `bytes=0-1` iOS probe is the trivial case.)
- Always emit `Accept-Ranges: bytes` on media responses once we can honor
  ranges ourselves; set `Content-Length` whenever the total is knowable
  (upstream CL or `Content-Range` total).
- **Prevention**: a contract probe in CI / healthcheck — `Range: bytes=0-1`
  against a fixture txid through `/api/img` must return
  `206` + `Content-Range` (the exact curl that exposed this).

### F2 — `/api/img`: never accept an HTML fallback page as media (fixes the immutable-poison class)

Same file. If the winning response's `Content-Type` is `text/html` for an
`ar://`/`ipfs://` fetch, treat it as a gateway failure (prefer another gateway /
return `502 no-store`) — a data item is never legitimately `text/html` here
unless the stored content is HTML, which can be allowed explicitly when the
request context wants it. Never stamp `immutable` on a response that isn't the
content-addressed bytes. (Observed live: bogus txid → arweave landing page →
`200 text/html` + 1-year immutable from our proxy.)

### F3 — Classification: stop depending on someone else's mime (fixes B and all future mime-less rows)

- **Mint-side** (`components/MintForm.tsx` metadata block): write
  `content: { uri: animationUri, mime: mediaFile.type }` for video mints.
  One-line-class change; protects Kismet mints only.
- **Read-side** (covers externally-minted moments — both A and B are):
  in `resolveMomentMedia`, when `animation_url` exists but carries no mime and
  no extension, **attempt video** — `MomentVideo`'s existing `onAllError` →
  poster fallback already bounds the failure cost. (Optionally gate the fade-in
  on `videoWidth > 0` to avoid presenting audio-only files as black tiles.)
- **Heal the token**: re-point via the existing edit-metadata flow (it writes
  `content.mime` explicitly, `components/MomentDetailView.tsx:702-718`) or ask
  inprocess to refresh the timeline row.
- **Prevention**: the read-side fallback *is* the prevention — external mints'
  metadata quality can't be legislated.

### F4 — `InlineVideo`: stall watchdog (hardening, optional)

Advance the gateway walk when a source makes no loading progress for N seconds,
not only on hard `error` (`components/InlineVideo.tsx:249-258`). Converts
"silent black box" failures into fallback attempts. Keep N generous (≥10 s) to
avoid killing slow-but-alive loads.

### F5 — Secondary defects noted en route (fix opportunistically)

- Detail-page `<link rel="preload" as="video">` always points at the **direct**
  gateway URL while WebKit/iframe surfaces play via the proxy URL — duplicate
  full-file download on the most constrained surfaces
  (`app/moment/[address]/[tokenId]/page.tsx:238-245`).
- CDN in front of `/api/img` (CDN_RUNBOOK) remains unapplied; after F1, a CDN
  must be configured to preserve `Range`/`206` behavior (runbook already covers
  this).
- Mint-side 100MB caps on faststart remux + duration probe
  (`lib/media/remuxFaststart.ts:4`, `lib/media/probeDuration.ts:4`) are real
  gaps for large *Kismet* uploads — not implicated in A or B, but they leave
  big mints without faststart or duration; consider a server-side remux path.

### Suggested order

1. **F1 + F2** (one PR — both live in `/api/img`; F1 un-breaks A everywhere).
2. **F3** read-side fallback + mint-side mime (un-breaks B's feed and inoculates the catalog).
3. Token healing for A and B is unnecessary after F1/F3 respectively, but B's
   inprocess row refresh is still worth requesting upstream.
4. F4/F5 as hardening follow-ups.

### Implementation status (2026-07-04, this branch)

- **F1 — IMPLEMENTED.** `lib/media/rangeContract.ts` (pure range math),
  `lib/media/gatewayFetch.ts` (manual redirect walk, domain-pinned, final-URL
  LRU), `app/api/img/route.ts` (206 synthesis on rangeless upstreams, 416,
  always-advertised `Accept-Ranges`). Guarded by
  `scripts/verify-img-range.ts` (wired into `verify:flows`).
  - **Production follow-up (2026-07-04):** the first deploy proved the
    contract live (`206 + Content-Range` from kismet.art) but iOS still
    refused — AVFoundation rejects a synthesized `bytes 0-1/*`
    (unknown-total) answer. Fixed by making totals REAL: per-URI
    `totalBytesCache` harvested from Content-Length / 206 denominators /
    completed passthroughs, plus a bounded **count-through** (read a
    rangeless body to EOF once, buffering only the requested window) so
    even the first probe answers `bytes 0-1/<exact-size>`. Suffix ranges
    (`bytes=-N`) now resolve against known totals too. Verified end-to-end
    against a live-shaped mock gateway in a real `next start`: probe →
    `206 …/65536`, follow-up `bytes=0-` → full-range real 206, mid-file
    byte-exact, suffix + 416 correct.
- **F2 — IMPLEMENTED.** HTML fallback pages lose the gateway race
  (`gatewayFetch.ts`) — never streamed, never cached.
- **F3 — IMPLEMENTED.** MintForm writes `content: {uri, mime}` for video
  mints; `resolveMomentMedia` attempts video for ambiguous animation_urls
  (mime-less + extensionless); `InlineVideo` rejects sources with no video
  track (`videoWidth === 0`) on FEED surfaces so a wrong guess degrades to
  the poster, never a black box — committed (detail) playback is exempt so a
  mislabeled audio-only video/mp4 stays playable through its native controls.
- **F4 — deliberately NOT implemented.** F1 removes the primary stall source
  (rangeless proxy responses); a stall watchdog's false-positive risk (killing
  slow-but-alive loads on weak links) currently outweighs its benefit. Revisit
  only with field evidence of stalls surviving F1.
- **F5 — preload mismatch IMPLEMENTED** (detail page preloads the proxy URL
  for WebKit-only UAs via the shared `isWebKitOnlyUaString`). CDN rollout and
  the mint-side 100MB caps remain open ops/product items.
- **Field follow-ups (2026-07-04, post-deploy):** video posters
  (`MomentImg skipProxy`) walked direct gateways only — on Mini App
  surfaces the direct path is the fragile one, so a failed video's poster
  died with it and the detail rendered "no preview" with nothing on
  screen; posters now try `/api/img` once after the direct walk exhausts
  (direct-first economics preserved). Feed page size capped at 10 on
  constrained surfaces (mobile UA or any iframe context, via
  `feedPageLimit` in `lib/paginatedGridQuery.ts`); standalone desktop
  stays 18.

- **Mobile Mini App misclassification (2026-07-04, field):** the Farcaster
  MOBILE Mini App hosts the app in a **React Native WebView** — not an
  iframe — and its custom UA carries none of the mobile tokens, so the
  surface fell through BOTH legs of every "constrained" check and was
  treated as an unconstrained desktop: 18-item eager feed, uncapped video
  decoders, no proxy-first media. (Field fingerprint: the 10-cap
  bifurcated on the desktop Mini App but not mobile.) Fixed with a third
  leg — `isReactNativeWebView()` (`lib/miniAppEnv.ts`), the host-injected
  `window.ReactNativeWebView` marker, definitionally a phone webview —
  wired through the feed cap, decoder caps, proxy-first video sourcing,
  the image walk short-circuits, and the detail first-frame seek.

### Open items (post-fix)

1. **CDN in front of `/api/img`** (CDN_RUNBOOK) — still the biggest lever
   for Mini App feel and the systemic answer to the box streaming every
   constrained-surface byte (and to the count-through's one-time full
   reads). Must forward `Range`/preserve `206` — the runbook's probes
   verify it.
2. **Second gateway in the pool** — `lib/arweave/gateways.ts` is down to
   arweave.net alone; when it degrades there is no fallback anywhere.
   Re-add a curl-verified AR.IO gateway (file comment documents the
   verification steps + next.config allowlist coupling).
3. **Desktop Mini App autoplay** — if feed videos still don't autoplay
   there after the delivery fixes, run
   `document.permissionsPolicy?.allowsFeature('autoplay')` in its console;
   a `false` means the host iframe lacks `allow="autoplay"` and no
   delivery fix can change it (detail playback via tap still works).
4. **Monitoring** — an external probe of
   `/api/img?u=ar://<known-txid>` with `Range: bytes=0-1` alerting on
   anything but `206` turns this class of outage into an alert instead of
   artist reports.
5. **Collection-chip covers that aren't images** (`_next/image` 400 at
   w=32): the optimizer rejects non-image sources; dwn2erth-style
   video-as-collection-cover data should be fixed at the source (the chip
   falls back gracefully meanwhile).
6. Upstream asks: inprocess `content:null` timeline rows; mint-side 100MB
   faststart/duration caps for large Kismet uploads.

---

## 5. Probe appendix (reproducible checks)

```zsh
# metadata copies (classification layer)
curl -s 'https://kismet.art/api/timeline?collection=<addr>&limit=50' | jq '.moments[] | select(.token_id=="1") | {metadata, kismet_duration_sec}'
curl -s 'https://kismet.art/api/moment?collectionAddress=<addr>&tokenId=1&chainId=8453' | jq '.metadata'

# delivery layer for a txid
curl -sI  "https://arweave.net/$TX"                                  # 302 = sandboxed serving
curl -sIL "https://arweave.net/$TX"                                  # final-hop: look for accept-ranges/content-length
curl -sI -H 'Range: bytes=0-1' "https://kismet.art/api/img?u=ar://$TX"   # MUST be 206 + Content-Range (iOS contract)
curl -sL --range 0-131071 "https://arweave.net/$TX" | head -c 131072 > /tmp/vh.bin
grep -abo moov /tmp/vh.bin | head -2 ; grep -abo mdat /tmp/vh.bin | head -2   # faststart check
ffprobe -v error -show_entries 'format=duration,size:stream=codec_type,codec_name,width,height' "https://arweave.net/$TX"
```

Reference results (2026-07-03): A's txid `-St2VqsjVd8ZWOzAYLVCG1pyC-KAHKTu8DaLbmfK4co`
→ 302-sandboxed, final hop rangeless/lengthless, file faststart 35 s 720×576
h264/aac; proxy range probe → `200` (contract violated). B's txid
`TQb6VDfjAfZdkb5XYFbDSVf-vXCRUVqiwjsUc1FYGKE` → 302-sandboxed likewise.
