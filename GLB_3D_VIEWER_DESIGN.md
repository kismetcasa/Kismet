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

## 13. Still left to be desired

Known and deliberate, in rough priority order:

1. **No AR.** iOS Quick Look needs USDZ; converting GLB→USDZ server-side means
   `usdzconvert` or Blender — the one part of this feature that would add a
   real backend dependency. Android's Scene Viewer takes GLB directly, so an
   Android-only `ar` mode is available cheaply if wanted.
2. **The `3D` badge is only on `MomentCard`.** `MarketOvals`, `FeaturedMoment`
   and `PatronArtworkShowcase` render a model's still with no indication it is
   3D. Correct, just a missed signal — the homepage hero is the one worth
   reconsidering.
3. **No lighting or environment control.** model-viewer's neutral default may
   not match an artist's intent; `environment-image`, `exposure` and
   `shadow-intensity` are all available and none are exposed.
4. **A 3D moment cannot be created by the edit flow or the agent API.** Both
   would need their own poster-capture step. Refused explicitly rather than
   half-supported.
5. **Poster resolution tracks the preview's rendered size** (~500–1900 px). A
   fixed-size capture would need a second parse of the model or visible resize
   jank, both worse trades against the mobile-memory risk.

## 14. Open product question

GLB is currently a **collector-gated download**. If a GLB can also be public
primary media, the bytes sit world-readable on Arweave and the gating premise
partially collapses for an artist who does both.

These are two different products — "the work is 3D" versus "collectors get the
model file" — and an artist could legitimately want either, or both with
different models (a display-res GLB public, the full-res source gated). Worth
an explicit decision rather than letting it fall out of the implementation.

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
| 8 | Poster resolution tracks the preview's rendered size | Low | **Accepted, and materially better since finding 15.** The preview is now a true square at the form column's width, so capture is roughly 620–1900 px square rather than 150 px tall. Same convention as `extractVideoPoster` (native size); a fixed-size capture would still need a second parse or visible resize jank — worse trades against risk 3. |
| 9 | A 3D moment can't be created by the edit flow or the agent API | Low | **Accepted, deliberate.** Both would need their own poster-capture step; refusing with a reason beats half-supporting it. |
| 10 | `arweave.net` is the sole gateway (`gateways.ts`) | Low | **Pre-existing.** A GLB inherits it and adds nothing; `MomentModel` walks the same pool and leads with the proxy in Mini App contexts. |
