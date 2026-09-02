# Minting a GLB as primary media — feasibility and design

**Question.** An artist wants to mint a `.glb` and have it display as an
interactive 3D viewer on the artwork page.

**Verdict: feasible, and cheaper than it looks.** Roughly 80% of the hard
infrastructure already shipped for the collector-download feature — the
dependency, the self-hosted decoders, the magic-byte detector, a working
a11y-complete viewer component, and a written record of the mobile memory
budget. What is missing is the *mint path* and the *classification*, and both
fit the shapes the codebase already has for video. **No on-chain change, no new
API route, no new storage, no new external dependency.**

There is also a live data-integrity bug on this path today (§2) that should be
fixed whether or not 3D ships.

---

## 1. What already exists

Shipped in the collector-file feature (`COLLECTOR_DOWNLOADS_DESIGN.md` §
"Viewer + SVG"), all reusable as-is:

| Asset | Where | Note |
|---|---|---|
| `@google/model-viewer@4.3.1` | `package.json` | Already a direct dependency |
| Self-hosted Draco + KTX2 decoders | `public/model-decoders/` (1.3 MB static) | CSP-clean; model-viewer otherwise fetches these from `www.gstatic.com` at render time |
| Working GLB viewer | `components/CollectorFileViewer.tsx` | Lazy import, decoder pinning, `error`-event handling via `addEventListener` (React does *not* map `on*` props onto custom elements), full WAI-ARIA dialog contract |
| GLB magic-byte detection | `lib/collectorFileCore.ts:132` — `glTF` / `0x46546C67` LE | Never trusts extension or `Content-Type` |
| Kind registry | `lib/collectorFileTypes.ts` | `model/gltf-binary` MIME already defined |
| Mobile-memory precedent | Design doc risk register #10 | "practical mobile ceiling is nearer 5–10 MB" |

The expensive, easy-to-get-wrong decisions — which decoder files, where they
live, why they are self-hosted, how model-viewer reports load failures — are
already made and documented.

## 2. What is broken today (the screenshot)

`hooks/useFileUpload.ts` accepts **any** file. Only `maxBytes` is checked:

```ts
const accept = (f: File | undefined) => {
  if (!f) return
  if (opts.maxBytes && f.size > opts.maxBytes) { opts.onTooLarge?.(); return }
  ...
  setPreview(URL.createObjectURL(f))
}
```

The `accept="image/*,video/*,.gif"` attribute on the input filters the OS file
picker, but **drag-and-drop bypasses `accept` entirely**, and `.glb` has no
registered browser MIME so `file.type === ''`. Consequences, in order:

1. The blob URL is created and `preview` is set.
2. `MintForm.tsx:1656` branches on `file?.type.startsWith('video/')` → false →
   renders `<img src={preview}>` → **broken-image icon with the alt text
   "preview"**. That is exactly the screenshot.
3. **Worse, nothing stops the mint.** `MintForm.tsx:1221` computes
   `animationUri = undefined` (not a video), so
   `finalImageUri = posterUri ?? mediaUri` resolves to the GLB txid, and the
   metadata ships:

   ```json
   { "image": "ar://<glb-bytes>" }
   ```

   A permanently broken artwork, on-chain, with Arweave credits spent. Every
   render surface, the OG card, the Farcaster embed and the collection cover
   all point at bytes no `<img>` can decode.

**Phase 0 below fixes this independently of the 3D feature.** Any unsupported
drop should be rejected with a toast, not silently minted.

## 3. Metadata shape — reuse the video shape exactly

```json
{
  "name": "...",
  "description": "...",
  "image":         "ar://<poster.jpg>",
  "animation_url": "ar://<model.glb>",
  "content": { "uri": "ar://<model.glb>", "mime": "model/gltf-binary" },
  "kismet_thumbhash": "..."
}
```

No new fields. This is the OpenSea/Zora convention — both render GLB from
`animation_url` — so the token is portable off Kismet.

**No signing or protocol change.** `MINT_INTENT_TYPES` (`lib/intent.ts:79`)
carries only `tokenURI`; `lib/mint-proxy.ts` never inspects metadata content.
The whole feature is client-side plus render surfaces.

**It already degrades correctly.** Walk `resolveMomentMedia` with the above:
`isVideoMoment` is false (mime is not `video/*`, no video extension); the gif
checks miss; at the ambiguous-`animation_url` branch, `content.uri ===
animation_url` so `mimeDescribesAnim` is true and `model/gltf-binary` is not
`application/octet-stream`, so `vetoedByMime` short-circuits the video attempt;
it falls through to `src = meta.image` → **kind `image`, the poster**. So an
un-upgraded client, a stale cache, or a third-party marketplace shows the
poster rather than a black box.

That makes `content.mime` **load-bearing**: omit it and the same metadata gets
attempted as a video. `ar://` URIs carry no extension, so the mime is the only
signal — the same lesson `VIDEO_PLAYBACK_RCA.md` already paid for.

## 4. The poster is the entire trick

`model-viewer` exposes canvas capture on the element itself (verified in the
installed typings, `lib/model-viewer-base.d.ts:143-145`):

```ts
toDataURL(type?: string, encoderOptions?: number): string
toBlob(options?: { mimeType?: string; qualityArgument?: number; idealAspect?: boolean }): Promise<Blob>
```

So the mint form can render the dropped GLB in the preview slot the artist
wants anyway, wait for its `load` event, call `toBlob()`, and hand the result
straight into the **existing** poster pipeline —
`generateThumbhash(posterFile)`, `uploadToArweave(posterFile)`,
`finalImageUri = posterUri`. It is the same code path video already uses after
`extractVideoPoster`.

This is the highest-leverage decision in the design. Because the poster is a
real JPEG, a 3D moment becomes **structurally identical to a video moment on
every surface except the detail view**. Unchanged, with zero work:

- feed cards, grids, profile lists, market rows (`MomentCard`)
- OG share cards (`lib/media/shareImage.ts` → Satori)
- Farcaster embeds and the animated preview route
- `/api/img` proxy and the next/image optimizer path
- collection covers on auto-deploy
- the thumbhash blur placeholder
- `FeaturedMoment`, `PatronArtworkShowcase`, `CustomizePanel`, profile theming

**Let the artist pose it.** Capture from the element they are already looking
at, so orbiting to a chosen angle and hitting "use this view" sets the poster.
Near-zero cost, and it is a genuinely good artist-facing feature — the framing
of a 3D work is an authored decision, not a thumbnail chore.

Fallback if capture fails (context loss, a model that never loads): reject the
file rather than mint posterless. A 3D moment with no `image` is invisible on
every static surface, which is worse than a clear error at pick time.

## 5. Render surfaces — one WebGL context, ever

**Never mount `<model-viewer>` in a feed.** A grid is 20–50 cards; each live
viewer is a WebGL context plus GPU memory. On iOS WebKit — which is the
Farcaster Mini App webview, a primary traffic path — that is an immediate OOM.
This codebase has already been burned by exactly this class of bug: see the
`MomentCard` comment on animated GIFs pinning decoders off-screen ("a primary
OOM-crash contributor") and the reverted `content-visibility` experiment. This
rule should be pinned in a comment *and* in a `verify:flows` oracle, not left
to reviewer memory.

| Surface | Behavior |
|---|---|
| Feed cards, grids, market rows | Poster only, plus a small `3D` affordance badge. No WebGL. |
| Detail view (`MomentDetailView`) | The one live viewer. Poster paints first (the `showPosterLayer` pattern `MomentVideo` already uses), then a tap/click promotes to the interactive viewer. |
| Lightbox | `isZoomable` stays `image \| gif`. A model promotes to the viewer instead, exactly as video opts out of zoom today. |
| OG / embeds | Poster. Never a viewer. |

Tap-to-load is doing double duty: it bounds memory to a user who opted in, and
it defers the ~290 KB gzipped chunk to intent rather than page load.

## 6. Bundle — dynamic import is mandatory, not a nicety

`scripts/check-bundle-size.mjs` fails CI on 10% per-route growth.
`/artwork/[address]/[tokenId]/page` baselines at **1,280,438 B**. The
model-viewer module build is 475,096 B minified (~290 KB gzipped):

```
475096 / 1280438 = 37.1% growth  ->  CI red
```

A dynamic `import('@google/model-viewer')` behind the click keeps it out of the
route manifest entirely — the same trick `CollectorFileViewer` already
documents ("~444 KB chunk, outside the artwork route's manifest"). With that,
`bundle-baseline.json` needs **no bump at all**.

## 7. Backend — near zero

- **Arweave upload works as-is.** One fix: `uploadFile.ts:33` tags
  `Content-Type: file.type || 'application/octet-stream'`, and `.glb` gives
  `file.type === ''`. Re-wrap as a typed `File`/`Blob` with
  `model/gltf-binary` before upload so the gateway serves the right type. (The
  collector-file path deliberately uploads as `application/octet-stream`
  because magic bytes are its sole authority — different problem, different
  answer.)
- **CORS/CSP already permit it.** `arweave.net` serves
  `Access-Control-Allow-Origin: *`, and CSP `connect-src 'self' https: wss:`
  covers model-viewer's fetch. Self-hosted decoders mean nothing regresses if
  the CSP is later promoted from Report-Only.
- **`/api/img`:** add a `content.mime` guard so a GLB can never reach `sharp`.
  Defense-in-depth — `MomentImage` only ever receives the poster — but the
  route accepts arbitrary `ar://` and `MAX_RESIZE_SOURCE_BYTES` is 100 MB.
- **`/api/timeline`:** add `'model'` to the `media=` filter allowlist
  (`route.ts:230`), `MediaKind` (`lib/discoverState.ts:18`) and a
  `MEDIA_LABEL` chip. Cheap, and it makes 3D discoverable — a real product win
  for the artist asking.
- **No new routes, no chunk store, no env vars, no quota.** The GLB rides
  Arweave like any other media, so per-view bandwidth is a gateway's problem,
  not Upstash's — unlike collector files.

## 8. The real risk: size on mobile

The design doc already flagged this for collector files (risk #10): a 16 MB GLB
is ~32 MB of browser buffers plus GPU memory, against a practical mobile
ceiling nearer 5–10 MB. **Public media is a strictly worse exposure** — a
collector file is opened by holders who chose to, whereas an artwork page is
opened by anyone who taps a feed card, disproportionately inside the iOS Mini
App webview.

Mitigations, in order of value:

1. **Tap-to-load on detail.** Bounds the blast radius more than any cap.
2. **Hard cap ~30 MB for GLB** at pick time. The form's global cap is 420 MB,
   sized for video, and far too generous for a model.
3. **Soft warning above ~8 MB**, naming the mobile consequence.
4. **Suggest Draco compression** in the helper text. The decoders are already
   self-hosted, so a Draco GLB is a first-class path, and Draco routinely cuts
   geometry 5–10×.

## 9. Skip AR in v1

`model-viewer`'s `ar` mode needs a **USDZ** on iOS (`ios-src`); iOS Quick Look
does not read GLB. Server-side GLB→USDZ means Apple's `usdzconvert` or Blender
— the one part of this feature that would add a genuine new backend
dependency, for a button most collectors will not press.

Android's Scene Viewer consumes GLB directly, so `ar` could be enabled
Android-only later at near-zero cost. Recommend deferring both.

## 10. Sequencing

**Phase 0 — stop the broken mint (ship regardless, small).**
Give `useFileUpload` an `accept` predicate; reject unsupported drops with a
toast instead of a broken preview and a garbage `image` field. This is a
data-integrity fix, not feature work.

**Phase 1 — the feature.**
GLB accept + 4-byte `glTF` magic check at pick time (reuse the collector-file
detector's approach — never trust the extension) → `<model-viewer>` preview in
the mint form → artist-posed `toBlob()` poster → existing poster/thumbhash/
upload path → `content.mime` in metadata → `'model'` kind in
`resolveMomentMedia` → detail-view tap-to-load viewer → `3D` badge on cards.

**Phase 2 — discovery and pinning.**
`media=model` filter and chip; `verify:flows` oracles for the three invariants
that would otherwise rot (no WebGL in feeds; poster required; metadata shape);
size warnings; the `/api/img` guard.

## 11. Implementation record (Phase 0 + Phase 1)

What shipped, and where the reasoning lives in the code.

### New modules

| File | Role |
|---|---|
| `lib/glbFormat.ts` | The GLB identity — `.glb`, `model/gltf-binary`, the `glTF` header magic — in ONE place. Zero imports, client-safe. **Both** features that accept GLB now read it: `lib/collectorFileTypes` (ext/MIME) and `lib/collectorFileCore` (magic). They have to agree — an artist dropping the same file into the MEDIA slot and the collector-download slot must get the same verdict. |
| `lib/media/modelMedia.ts` | GLB specifics for the media path: `MODEL_MAX_BYTES` (30 MB), `MODEL_SOFT_WARN_BYTES` (8 MB), `isGlbFile` (magic sniff), `asGlbFile` (re-wrap with the real MIME). |
| `lib/media/mintMedia.ts` | The media gates: `checkMintMedia` (mint — image/video/gif/model), `checkReplaceMedia` (edit — same, minus model), `checkCoverImage` (covers — stills only). |
| `components/ModelPreview.tsx` | Mint-form 3D preview **and** poster source. |
| `components/MomentModel.tsx` | The detail view's tap-to-load viewer. The only WebGL surface. |
| `scripts/verify-model-media.ts` | 30-assertion oracle, wired into `verify:flows`. |

### The four decisions that carry the feature

**1. `src` is the still, `modelSrc` is the GLB.** `resolveMomentMedia` returns
`kind: 'model'` with the *poster* in `src`. This looks backwards next to
`video` (where `src` is the video) and is the single most important choice
here: `MarketOvals`, `CustomizePanel`, `FeaturedMoment`,
`PatronArtworkShowcase` and the profile-theme route all read `src` as an
image. With the still in `src` they needed **no changes at all**, and a
surface anyone forgets renders a correct static tile instead of feeding GLB
bytes to an `<img>` — or, server-side, to `sharp`. The new kind fails safe by
construction rather than by vigilance. The oracle pins it.

**2. The poster is captured from the posed preview.** `<model-viewer>`
exposes `toBlob()` over its own canvas, so the element the artist is already
looking at is the poster source — no second parse of the model (which would
double peak memory) and no server-side renderer. Capture runs on `load` and
again 400 ms after the artist stops orbiting, so the framing they land on is
what ships. Two facts verified in the installed source make this sound rather
than lucky: the renderer sets `preserveDrawingBuffer: true`, and `load` is
dispatched only *after* model-viewer awaits two rAFs specifically to "wait for
shaders to compile and pixels to be drawn".

**3. A 3D moment takes the video binding verbatim.** One line in `MintForm`
(`mediaFile.type.startsWith('video/') || isModelMedia`) produces
`animation_url` = GLB, `image` = still, `content.mime` = `model/gltf-binary`.
Keying off `mediaFile.type` rather than the picked file means the cross-reload
resume path — which rehydrates only the persisted `mediaType` — binds
identically with no extra state. `asGlbFile` is what makes that work:
browsers report `File.type === ''` for `.glb`, so the re-wrap is what gives
Arweave the right `Content-Type` tag *and* the binding its signal.

**4. Exactly one WebGL context.** Feed cards render the still plus a `3D`
badge and never mount a viewer; the detail view mounts one behind a tap.

Measured on a clean production build: the model-viewer chunks exist on disk
but appear in **no route manifest at all**, and the artwork route came in at
1283.8 KB against a 1250.4 KB baseline — **+0.26%** where a static import
would have been +37% against a 10% guard. `bundle-baseline.json` needed no
bump.

### The Phase 0 bug, and its blast radius

`useFileUpload` validated only size. `accept` on an `<input>` filters the OS
picker dialog and **drag-and-drop ignores it entirely**, so any file reached
the mint form. Now `useFileUpload` takes an async `accept` gate (returning a
human-readable reason) with a monotonic pick token so a slow magic-byte sniff
on one file can never install itself over a later pick.

Auditing for the fix turned up the *same* bug on two more pickers, both of
which would produce the identical permanently-broken artwork:

- **Edit → replace media** (`MomentDetailView`): its non-video branch uploads
  the picked file and writes the returned URI straight into `image`. Now
  gated by `checkReplaceMedia`, which also refuses models — that path has no
  poster-capture step, so accepting one would break an artwork that currently
  works. The refusal says so.
- **Edit → change cover**: a cover renders as a still everywhere, so
  `checkCoverImage` refuses video and 3D.

### Verified, not assumed

`npm run verify:model-media` (30 assertions) pins the mint gate (a zip, a PDF,
a typeless binary and a non-GLB named `.glb` are all rejected; a GLB named
`.bin` is still a model), the fail-safe `src`/`modelSrc` shape, the degenerate
`image === model` legacy guard, the posterless case, and that the four
pre-existing kinds are unaffected. `verify:collector-file` still passes
unchanged, proving the shared-identity refactor was behaviour-neutral.

Full `npm run check` — typecheck, lint, the bundle guard and every
`verify:*` suite — passes on a clean build.

## 12. Line-by-line audit (post-implementation)

Every committed line re-read adversarially, asking whether it earns its keep.
Fourteen findings; all fixed.

**Dead code — written, never used.**

- `hasGlbExt()` had zero callers, and its own doc comment claimed uses ("the
  drop zone's hint text and the `accept` attribute") that were literals and
  `GLB_EXT` respectively. Deleted.
- `MomentModel`'s `elRef` was assigned on every ref attach and never read.
  Deleted.
- `MintForm`'s `clearFile` wrapper: both statements were provably redundant.
  `isModelPick` compares the gate's verdict *by identity* against `file`, so a
  null `file` already makes it false whatever the ref holds; and the
  `[file]` effect already drops the poster. The wrapper existed only because
  I hadn't followed my own design through. Deleted — along with the
  `useCallback` import it was the sole user of.

**Redundancy and drift hazards.**

- `checkMintMedia` matched one combined extension pattern, then re-matched a
  *second copy* of the video subset to pick the kind — the video list written
  twice, one edit away from disagreeing with itself. Split into `IMAGE_EXT` /
  `VIDEO_EXT` and composed; both branches oracle-pinned.
- `MomentModel` kept `gatewayIndex` in both state and a ref. The ref existed
  to avoid an impure `setState` updater, but putting `gatewayIndex` in the
  ref-callback's deps solves the same problem with one source of truth.
- `videoGatewayUrls(src)` ran on every render — it reads `window.top` inside a
  try/catch and sniffs the UA. Now memoized on `[src]`.
- `isGlbFile` and `isMintableGlbFile` were always called together and each
  read the file's head separately, so reaching one decision cost two reads.
  Collapsed into `inspectGlbFile`, a single read returning a three-way
  `'no' | 'malformed' | 'ok'` — which is the shape the caller actually needs,
  since "not a model" and "a model we can't render" are different answers.
- `useFileUpload` held `opts` in a ref so its `accept` could be a `useCallback`
  with `[]` deps. Nothing needed that stability — `accept` is only reached
  through the `onChange`/`onDrop` closures, which are rebuilt every render
  regardless. The memoization existed only to create the stale-closure problem
  the ref then solved. Both removed; `opts` is read straight from the current
  render.

**Behavioural corrections.**

- Retry after an exhausted gateway walk only re-hit the *last* gateway. The
  likeliest real failure here is an Arweave propagation 404 moments after a
  mint, so the retry now restarts the walk.
- The large-model warning toast fired from inside the gate, which can run for
  a pick a faster second drop supersedes — warning about a file that never
  became the media. Moved to the `[file]` effect, after the pick is installed.
- The `/api/img` comment claimed a model "must not reach sharp". Reading the
  route showed sharp's throw is already caught and degrades to a byte
  pass-through, so the guard saves a wasted 100 MB buffer and a scarce compute
  slot — not a crash. Comment corrected to say what is actually true, and to
  note that an *untagged* model still takes the old path (which is why
  `asGlbFile` tags them at upload).

**Gaps the audit surfaced, now closed.**

- **The still vanished on tap.** Promoting to 3D swapped a finished artwork
  for an empty box for the length of a multi-megabyte download — worst on
  exactly the connections this feature is most exposed on. The still now stays
  mounted beneath the viewer and fades out only on the model's own `load`
  (the `showPosterLayer` pattern `MomentVideo` already uses), and the
  `progress` event drives a percentage.
- **`auto-rotate` ignored `prefers-reduced-motion`.** Verified against the
  installed package: model-viewer has no built-in handling, so it span
  indefinitely regardless of the OS setting — continuous unstoppable motion,
  which is what WCAG 2.2 SC 2.2.2 addresses. Now gated on `no-preference`,
  matching `ProfileThemeBackdrop` and `globals.css`.
- **A truncated GLB minted successfully** and only failed later in the
  viewer. The 4-byte magic is all the collector-file detector needs (it
  re-serves bytes it never parses), but a mint is irreversible and paid for.
  The gate now reads the full 12-byte glTF header and rejects a declared
  length exceeding the real byte count (truncation) or a version other than 2.
  Deliberately `<=` rather than `==` so trailing-padded files that render fine
  aren't rejected more strictly than the renderer does.
- **The poster capture was invisible to the artist.** Nothing told them the
  angle they leave the model at becomes the thumbnail every feed and share
  card shows. A caption now says so.

**Also confirmed:** `react-hooks/exhaustive-deps` is not enabled in this
repo's ESLint config, so hook dependency arrays are unchecked by tooling and
were verified by hand.

### Finding 15 — from the artist, not from the audit

The mint preview rendered as a full-width, 150px-tall strip instead of a
square. Cause: model-viewer's shadow stylesheet sets
`:host { width: 300px; height: 150px; contain: strict }` (`lib/template.js`),
and CSS `aspect-ratio` is ignored when the other dimension is explicitly set —
so the inline `aspectRatio: '1'` with no `height` lost to that `150px`.

It was **not only cosmetic**. `toBlob` captures at the element's own rendered
size, so the POSTER was being grabbed at roughly 620x150 as well — a squashed
letterbox destined for square feed cards, OG cards and embeds. The box is now
sized by a `relative w-full aspect-square` wrapper with the element at
`height: 100%`, which fixes the preview and the capture together and lifts
capture resolution from ~150px tall to the full column width. `MomentModel`
was never affected: it sets an explicit `height: 100%` inside a definite-height
`absolute inset-0` wrapper.

Worth recording *why this survived*: typecheck, lint, the 44-assertion oracle
and the bundle guard were all green on it. Nothing in the suite renders a
layout, so nothing could have caught it. It took one look at the actual
screen — which is the honest limit of what the verification here proves.

## 13. Browser end-to-end validation

`scripts/e2e/model-media.mjs` — 30 assertions against a real Chromium, a real
WebGL context and a spec-valid glTF 2.0 cube, driving a production build.
Deliberately outside `npm run check` (it needs a built app, a running server
and a browser); see `scripts/e2e/README.md`.

It exists because finding 15 proved the rest of the suite structurally cannot
catch a layout: a preview that rendered — and captured — at the wrong size was
green on typecheck, lint, the oracle and the bundle guard. So this asserts
pixel geometry and capture *output*, not just that pages load.

What it confirmed, all passing across three consecutive runs:

| Area | Confirmed |
|---|---|
| Mint | The preview is square, a real GLB loads, and `toBlob` yields a **956×956** JPEG — direct proof of the finding-15 fix, since the same capture was ~620×150 before it. Posing changes what would be captured; the pose hint is visible. |
| Gate | A zip, a **truncated** GLB and a **glTF 1.0** binary are each rejected with the exact copy, and leave no preview mounted. |
| Detail | The still paints first; **no WebGL exists before the tap**; tapping mounts exactly one viewer; the still fades only after the model paints; exiting unmounts the viewer and restores the affordance. |
| Reduced motion | `auto-rotate` is off under `prefers-reduced-motion` and on without it — the WCAG 2.2 SC 2.2.2 fix, verified rather than assumed. |
| Slow load | The progress readout appears and the still stays visible throughout, so a big model on a slow link never shows an empty box. This state had never been observed before. |
| Feed | A 3D moment renders its still (proving the one-line `MarketOvals` change — the tile would otherwise be blank) and **no `model-viewer` is ever mounted in a feed**. |

Two harness bugs were fixed along the way, both worth recording because each
would have produced false confidence: reading a sonner toast via `.first()`
could pick one still animating out, and `page.reload()` followed immediately
by `setInputFiles` could beat hydration — which would have made "leaves no
preview mounted" pass **vacuously**, since nothing ran at all.

**Not covered:** `MomentCard`'s `3D` badge. Every page that renders that
component needs SSR data or on-chain reads that cannot be stubbed from the
browser. Its condition is oracle-pinned; the markup is unverified on screen.

### Finding 16 — the backdrop is authored, and had to be recorded

The artist asked for a white background. Acting on that literally would have
shipped a visible bug: the mint preview captured on `#111` while the artwork
page's viewer rendered `transparent` over the near-black page. Those two were
already inconsistent — nobody noticed because both happened to be dark. Making
only the capture white would have meant tapping "view in 3D" swapped a white
still for a model on black, which reads as breakage rather than a choice.

So the backdrop is now an authored decision with one definition
(`MODEL_BACKGROUNDS`), picked in the mint form, stored as `metadata.kismet_bg`
and replayed by the viewer. Three things have to agree — the preview, the JPEG
captured from it (no alpha, so the backdrop is baked in permanently), and the
live viewer — and `modelBackgroundCss` falls back to the default rather than
to transparent so a moment minted before the field existed still renders on
the backdrop its poster was baked on.

Default is **white**: a model on white is the neutral product-shot
presentation, and it is what reads as intentional on a share card or an embed,
where the surrounding surface is not ours to control. Dark stays one tap away.

Two things fell out of it: the progress readout is now chipped (grey on white
would have been sub-AA once a backdrop could be light), and changing the
backdrop re-captures the poster, since the banked one has the old colour baked
in.

**And a bug only a pixel could find.** Setting the backdrop revealed that
`model-viewer` renders the scene into a **transparent** buffer — the CSS
background is a DOM layer *behind* the canvas, not part of it. So
`toBlob({mimeType:'image/jpeg'})` returns the model composited onto **black**,
whatever the element shows on screen. Every poster was black-backed from the
start; the original `#111` never reached a single one, and it went unnoticed
only because black and `#111` look alike. The capture now takes a **PNG**
(alpha intact) and composites onto the chosen colour itself.

The browser check pins all three halves of this so it cannot regress quietly:
the rendered element's corner is the chosen colour, model-viewer's own JPEG is
black, and its PNG has alpha 0. If anyone "simplifies" the capture back to a
direct JPEG, that middle assertion is what fails.

### Findings 17-20 — reviewing the backdrop commit

**17. A model that never loads banked a blank poster.** The re-capture effect
fired on `ready`, not on `load`, so a GLB with a valid 12-byte header and
corrupt chunks — which passes the gate, because the gate reads only the header
— produced a picture of an *empty scene*, composited onto the backdrop into a
perfectly valid-looking blank JPEG. That defeats the mint's "refuse rather
than ship a posterless 3D moment" guard, because the poster is not null, just
blank: the artist would have minted a white square.

Proven, not reasoned: instrumenting `canvas.toBlob` showed **2 composites** on
a model where `loaded` never became true. Fixed by gating the effect on a
`loadedRef` set in the `load` handler, and the browser check now asserts zero
composites for exactly that file.

**18. The re-capture delay was cargo.** The effect waited 120 ms "once the new
colour has painted" — but `capture` fills the colour itself (`ctx.fillStyle =
background`) and never reads the painted DOM. The timer and its justification
were both wrong. Removed.

**19. The fallback had two sources of truth.** `modelBackgroundCss` fell back
to `MODEL_BACKGROUNDS[0]` while its contract said "the default". Those are the
same entry today; reordering the array would have silently changed what every
pre-`kismet_bg` moment renders on, with the comment still claiming otherwise.
Now resolved through `DEFAULT_MODEL_BACKGROUND` and oracle-pinned.

**20. The backdrop swatches were 16px targets.** Under WCAG 2.2 SC 2.5.8's
24px minimum, and too close together to claim the spacing exemption — while
this codebase already uses `min-w-9` hit areas on its card overlays for
precisely this reason. Now a 24px hit area around the 16px visual dot.
`verify:a11y` scans text contrast only, so nothing in the suite could see it;
the browser check now measures the button box.

Two of these four (17, 20) were invisible to every non-browser check, which is
the same lesson as finding 15 arriving twice more.

### Findings 21-22 — the artist's second round

**21. The thumbnail and the in-app view are different contexts.** The artist's
read, and it is correct: the shared image wants white (the presentation the
NFT world already parses that way — Zora's is always white), while inside our
own dark page a model can sit *in* the page rather than in a box. Coupling
them forced one answer to both questions.

Each `MODEL_BACKGROUNDS` entry now carries two colours behind one stored id:
`poster` (always opaque — a JPEG has no alpha and it travels to surfaces whose
surrounding colour is not ours) and `viewer` (may be `transparent`). The third
option is exactly the artist's proposal: white thumbnail, transparent in app.
The accepted cost is that promoting to 3D then crossfades the backdrop — which
is why it is one option among three rather than the rule, and it rides the
300 ms fade the still already had. `EVERY option has an opaque poster colour`
is oracle-pinned so a future entry cannot bake transparency into a JPEG.

**22. `shadow-intensity` defaults to 0.** Verified in the installed package:
model-viewer renders **no shadow at all** unless asked, which is exactly why
an untextured model reads as a flat silhouette — worst of all against the
white default this branch just made standard. A grounding shadow is now on
everywhere a model renders, including the mint preview, because the preview
IS the poster source and the thumbnail would otherwise differ from what the
artist posed. It lands in the capture for free: the shadow is part of the
rendered scene, not a DOM layer.

### Post-merge verification

Verified against the merged `main` (PR #680), not the branch: the merged tree
is byte-identical to what was reviewed, `npm run build` and the full
`npm run check` both exit 0, and the browser check passes 44/44.

**Bundle cost, measured rather than estimated.** Building `0ce7503` (main
before any of this) and diffing route totals against merged main attributes
the whole feature at:

| Route | Delta |
|---|---|
| `/artwork/[address]/[tokenId]` | **+7,446 B (+0.57%)** |
| `/mint` | +7,054 B (+0.52%) |
| `/collection/[address]` | +4,757 B (+0.36%) |
| `/layout` | +191 B (+0.01%) |
| 31 of 39 routes | unchanged |

`model-viewer` appears in **no route manifest** — still fully lazy. Note for
whoever owns the guard: `bundle-baseline.json` is stale from *other* merged
work (`/layout` was already +4.5% over baseline before this branch existed),
so the guard's 10% headroom is eroding for reasons unrelated to 3D.

**2026-09-02 follow-up (badge, edit-flow and agent 3D parity, ROM kinds,
prompt audit).** Measured the same way — a control build of `744c748` (the
branch before this work) diffed against this build, route by route:

| Route | Delta vs control |
|---|---|
| `/artwork/[address]/[tokenId]` (+ its modal) | **+6,077 B (+0.46%)** |
| `/mint` | +507 B (+0.04%) |
| every other route | ≤ +279 B; 22 of 38 shrank slightly |

The artwork route pays for the edit flow's 3D branch and the shared pose
bar; `ModelPreview` itself is code-split there (`next/dynamic`, ssr:false)
and `model-viewer` is still in no route manifest. The committed
`bundle-baseline.json` had drifted **+35,989 B on the artwork route before
this branch** (other merged work), which is why the naive guard reading was
+3.3%; the baseline is regenerated in this PR so the 10% guard measures from
today's sizes.

The browser check (scripts/e2e) now runs **49 assertions**, all passing on
this build: the three new ones render a real `MomentCard` grid from the
intercepted timeline on the profile page, assert the `3D` badge on the card,
and confirm no `model-viewer` mounts in that grid either. The stubbed timeline
row's `creator` had to become a `MomentAdmin` object — the card reads
`creator.address` for its avatar, and a string there crashed the page — which
the older ovals-only feed check never exercised.


Two findings from that pass, both fixed:

- **`readGlbHeader` was an exported function nobody imported** — used only by
  `isWellFormedGlbHeader` beside it. Now module-private; the two verdict types
  next to it stay exported because they appear in four exported signatures and
  are the documented return contract.
- **The browser check had a cold-start race.** On a freshly started server the
  first `/mint` request compiles a large lazy chunk, and a cold run could lose
  the 30s selector race — a red that says nothing about the code. It now warms
  the route first; re-verified passing 44/44 from a deliberately colder start
  than the one that failed.

## 14. Still left to be desired

Known and deliberate, in rough priority order:

1. **No AR.** iOS Quick Look needs USDZ; converting GLB→USDZ server-side means
   `usdzconvert` or Blender — the one part of this feature that would add a
   real backend dependency. Android's Scene Viewer takes GLB directly, so an
   Android-only `ar` mode is available cheaply if wanted.
2. **The `3D` badge is on `MomentCard` and the homepage hero (2026-09-02).**
   Both render `components/ModelBadge` — one definition; the feed placement
   is asserted in the browser E2E. `MarketOvals` is 44px ovals with no room
   for a badge, and `PatronArtworkShowcase` is contractually "the image
   alone" — both render a model's still correctly and stay unadorned on
   purpose.
3. **No lighting or environment control.** model-viewer's neutral default may
   not match an artist's intent; `environment-image`, `exposure` and
   `shadow-intensity` are all available and none are exposed.
4. **The edit flow and the agent API create 3D moments (2026-09-02).** The
   edit flow reuses the mint form's pose-and-capture verbatim (`ModelPreview`
   + the shared `ModelPoseBar`, the identity-tracked pick, the same refusal
   without a capture) and now carries `kismet_bg` through every edit — a
   title-only edit used to rebuild the metadata without it and silently reset
   the backdrop. The agent API accepts a GLB (bytes-identified, header-checked,
   25 MB) with a caller-supplied `poster` — a server cannot render one, so it
   is required — and a `background`. All three producers write the shape
   through one builder, `modelMomentFields`, pinned by `verify:model-media`
   and `verify:agent`. Neither flow is driven in a browser: the edit flow needs
   a creator session and an on-chain write, the agent path a signing wallet.
5. **Poster resolution tracks the preview's rendered size** (~500–1900 px),
   deterministically: the render scale is pinned to 1 while posing (2026-09-02),
   so load can no longer halve a capture. A fixed-size capture would need a
   second parse of the model or visible resize jank, both worse trades against
   the mobile-memory risk.

## 15. Product question — resolved (2026-09-02)

GLB is both public primary media and a collector-gated download, and those
are two different products: "the work is 3D" versus "collectors get a file".
An artist can want either, or both with different files — Andrea's own
concept is exactly that (a public 3D Game Boy, a gated `.gb` cartridge). The
one footgun is gating the same file that already sits world-readable on
Arweave as the artwork.

Decision: support both, and make the trade-off visible at the two moments an
artist chooses. The mint form's collector-download slot, when the primary
media is a model, says the model itself is public and to gate something it
does not give away (source files, a ROM, a print-res export); the artwork
page's manage panel says the same when the artwork is 3D
(`primaryIsModel`). Nothing is gated or refused — the artist decides with
the facts in front of them. The cartridge itself is a first-class collector
file now (`.gb`/`.gbc`, COLLECTOR_DOWNLOADS_DESIGN.md), so the concept ships
without a zip.

---

## Risk register

Status as shipped. "Closed" means the code and an assertion both hold it;
"accepted" means the cost is deliberate and recorded.

| # | Risk | Severity | Status |
|---|---|---|---|
| 1 | Any file type mints as `image:`, permanently | **High** | **Closed.** `checkMintMedia` gates the mint picker; the same audit closed the edit-media and three cover pickers. Oracle-pinned. |
| 2 | WebGL in a feed grid OOMs the iOS Mini App | **High** | **Closed by shape.** Feeds read `media.src`, which for a model is the still — a viewer cannot be mounted there by accident. `MomentModel` is imported by the detail view alone. |
| 3 | Large GLB OOMs mobile even on the detail view | Medium | **Mitigated.** Tap-to-load (nothing downloads or parses until asked), 30 MB hard cap, 8 MB soft warning naming the phone consequence, Draco guidance, exit button that unmounts the context. |
| 4 | Missing `content.mime` → moment attempted as video | Medium | **Closed.** Always emitted; the shape is oracle-pinned, and the `.glb` extension covers external mints that lack it. |
| 5 | Static import blows the bundle guard (+37%) | Medium | **Closed.** Both viewers dynamic-import behind an interaction; `bundle-baseline.json` unchanged. |
| 6 | Poster capture fails → invisible on every static surface | Medium | **Closed.** The mint refuses rather than shipping a posterless 3D moment; capture is re-run on every pose, and a stale capture from a swapped-out model can't be adopted. |
| 7 | GLB reaches `sharp` via `/api/img` or the theme route | Low | **Closed.** `model/` excluded from the resize path; the theme route reads a model's still and never falls back to `md.image`. |
| 8 | Poster resolution tracks the preview's rendered size | Low | **Accepted, now deterministic (2026-09-02).** Capture is the element's CSS size × devicePixelRatio, no longer load-dependent: the renderer's dynamic scale is pinned to 1 while `ModelPreview` is mounted (restored on unmount, so the live viewer stays adaptive) after an E2E run under CPU load caught a 755 px capture where 956 px was expected. A fixed-size capture would still need a second parse or visible resize jank — worse trades against risk 3. |
| 9 | A 3D moment can't be created by the edit flow or the agent API | Low | **Closed (2026-09-02).** The edit flow reuses the mint form's pose-and-capture; the agent API requires a caller-supplied poster. One builder (`modelMomentFields`) writes the shape for all three producers, oracle-pinned. |
| 10 | `arweave.net` is the sole gateway (`gateways.ts`) | Low | **Pre-existing.** A GLB inherits it and adds nothing; `MomentModel` walks the same pool and leads with the proxy in Mini App contexts. |
