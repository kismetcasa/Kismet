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

## 11. Open product question

GLB is currently a **collector-gated download**. If a GLB can also be public
primary media, the bytes sit world-readable on Arweave and the gating premise
partially collapses for an artist who does both.

These are two different products — "the work is 3D" versus "collectors get the
model file" — and an artist could legitimately want either, or both with
different models (a display-res GLB public, the full-res source gated). Worth
an explicit decision rather than letting it fall out of the implementation.

---

## Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Live: any file type mints as `image:` today, permanently | **High** | Phase 0 — type validation at pick time |
| 2 | WebGL in a feed grid OOMs the iOS Mini App | **High** | Poster-only in feeds; pinned by comment + verify oracle |
| 3 | Large GLB OOMs mobile even on detail | Medium | Tap-to-load, 30 MB hard cap, 8 MB soft warning, Draco guidance |
| 4 | Missing `content.mime` → moment attempted as video | Medium | Always emit it; pin the metadata shape in `verify:flows` |
| 5 | Static import blows the bundle guard (+37%) | Medium | Dynamic import behind the click |
| 6 | Poster capture fails → invisible on every static surface | Medium | Reject at pick time rather than mint posterless |
| 7 | GLB reaches `sharp` via `/api/img` | Low | Mime guard on the route |
| 8 | `arweave.net` is the sole gateway (`gateways.ts`) | Low | Pre-existing platform risk; a GLB inherits it, adds nothing |
