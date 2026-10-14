# Zines — a PDF as the artwork, read page by page (design)

_Design for the feature requested by Arjan (arjantupan): bringing his poetry
zine **trpplzine** to Kismet as collectible issues. He needs "a platform that
supports pdf, or help building a digital file that acts like a pdf: a simple
multi-page file". This document answers the eight points Luciano set after the
first review, maps every part of the codebase the feature touches, and ends
with the questions that remain._

> **Status: design, not implemented.** Verified against the tree at `096a705`
> (2026-10-14) on `claude/dazzling-carson-gdrzti`. Every `file:line` below was
> read in this session; the pdf.js facts come from unpacking `pdfjs-dist@6.4.299`
> and reading its typings, not from memory. Where something could not be
> verified from this container (Arweave gateway headers, the live Turbo price,
> Arjan's actual file) it is marked as such in Appendix A.

---

## 0. What the artist asked for, and what was decided

Arjan's messages (2026-07-28), assembled:

1. *"What I would love to bring to the Kismet platform is my poetry zine
   trpplzine. I've made one issue last year, and I want to continue making
   them. But... I either need a platform that supports pdf, or help building a
   digital file that acts like a pdf: a simple multi-page file."*
2. *"The first one I made a printable pdf, but it was physical first. That
   basically was a scan of the master physical version. For a collectible NFT,
   I would separate the pages, and scan them in order of reading. The file I
   have is about 2.3 MB, and I expect the new file to not be much more."*
3. *"The zine is meant to be very much simple hand made and copied style. I
   invite poets to write a poem, which I type out on a type writer. I cut the
   poem out to stick on the page, and add a printed paragraph of positive
   AI-commentary on the poem. The back of the zine has visual art."*
4. *"Last time I made an extremely simple html version for manifold, but I was
   not happy with it."* (trpplzine issue #0 on Manifold — not reachable from
   this container; see §18.)
5. *"Can't seem to attach pdf here, though."* — said in the Base app's DM
   composer, not in Kismet (Kismet has no messaging surface: `app/` has no
   messages route). Not a Kismet bug.

So: **a recurring series of issues, each a multi-page document of scanned
pages in reading order, small files, a hand-made aesthetic, and a reader that
turns pages.** He is flexible on the file format; the pages are the point.

Luciano's decisions (2026-10-14), which this design implements:

| # | Decision |
|---|---|
| 1 | Page-by-page image sequence, "like reading a magazine". Research the best reading experience. |
| 2 | Two options per artwork: **public** or **collectors-only** ("private collectible"). Find the simplest, most effective way to offer both. |
| 3 | Public = upload the PDF to Arweave and render the whole thing; confirm whether that is the right call (§4: yes, with qualifications). |
| 4 | The artist uploads the **entire PDF**. Collectors-only = the PDF plus a cover image. The cover is **optional** for both modes: with no cover, **page 1 is what shows**. Everything renders in "our page by page zine style viewer". |
| 5 | **420-page cap**. Decide whether a file-size cap is also needed and why (§7: yes, 64 MiB, one number for both modes). |
| 6 | Inventory every component and option to address for artists and readers; decide whether and where a discovery filter is needed (§11). |
| 7 | Issue #0's PDF — did not arrive as an attachment and is not in Google Drive; see §18. |
| 8 | Complete the design first; ask about remaining gaps (§18). |

---

## 1. Verdict

**Feasible, and most of it rhymes with two features that already shipped.**
The 3D viewer (`GLB_3D_VIEWER_DESIGN.md`) established the exact shape for a
non-image primary media kind: a real cover JPEG in `image`, the file in
`animation_url` + `content.mime`, every static surface renders the cover, one
interactive viewer on the detail page behind a tap, a dynamic import that stays
out of the route manifest. The collector-download feature
(`COLLECTOR_DOWNLOADS_DESIGN.md`) already stores PDFs privately in Redis, gated
to holders, versioned, with notifications; it lacks only an in-page viewer,
which it deliberately deferred *because* it would cost a pdf.js dependency.
The public zine pays for that dependency, so the private zine gets its reader
almost for free.

What is new:

- **A `pdf` primary media kind** (gate, poster from page 1, metadata binding,
  resolver, badge, filter) — the GLB pattern applied a second time.
- **The reader**: a full-screen, swipe/tap/keyboard paged reader with spreads
  on wide screens, zoom, deep links and resume, built on pdf.js as a page
  rasterizer (§5, §6). It serves both modes from one component.
- **`pdf` becomes a viewable collector-file kind**, plus a page count on the
  record and a "Read" affordance for holders (§10).
- **A mode control in the mint form** that routes the same PDF to Arweave
  (public) or to the collector-file store (collectors-only), with the cover
  rule from decision 4 (§9).

What this design says no to for v1, with the reasoning in §4 and §11:
pre-rasterizing pages at mint, a server-side page renderer, pdf.js's own range
streaming (until the CDN fronts `/api/img`), a selectable text layer, preview
pages for non-collectors, and any page-curl animation.

**No on-chain change, no new storage, no new env var, no server-side PDF
parsing. One new dependency (`pdfjs-dist`, Apache-2.0), self-hosted assets
copied at `postinstall` like ffmpeg-core, one guard on `/api/img`, one new
viewable kind on the collector-file route.**

---

## 2. What already exists

| Asset | Where | Reused for |
|---|---|---|
| The media gate and its drag-and-drop lesson | `lib/media/mintMedia.ts:41-75`, `hooks/useFileUpload.ts:60-73` | add a `pdf` verdict; the hook's async `accept` is where page count and caps are checked |
| Poster → thumbhash → upload pipeline | `components/MintForm.tsx:1257-1262` (video), `components/ModelPreview.tsx:148-188` (model, JPEG 0.85), `lib/media/thumbhash.ts:72-90`, `lib/arweave/uploadFile.ts` | page 1 rendered to a JPEG `File` goes down the identical path |
| The video/model metadata binding | `components/MintForm.tsx:1355-1361`, metadata at `:1407-1427` | one more `||` in the binding, `content.mime = application/pdf` |
| Fail-safe resolver precedent | `lib/media/resolveMomentMedia.ts:99-107` (model: `src` = still, `modelSrc` = GLB; `:105` guards `image === model`) | `kind: 'pdf'`, `src` = cover, `pdfSrc` = the PDF, same guard |
| Resolver already fails safe on PDF metadata | `lib/media/resolveMomentMedia.ts:155-161` — `application/pdf` vetoes the video guess and `.pdf` is in `NON_VIDEO_EXT` | an un-upgraded client (or a stale feed row) renders the cover, never the bytes |
| Tap-to-load viewer with owned download | `components/MomentModel.tsx` (phases `:59`, activate `:143-199`), `lib/media/modelFetch.ts` (stall 20 s, timeout 5 min, 64 MiB cap, magic check, progress), `lib/media/gateway.ts:96-105` (`modelFetchUrls`, proxy always last) | the reader's entry and download are the same machine with a `%PDF-` magic check |
| Lightbox shell + hooks | `components/MomentDetailView.tsx:2556-2583`, `hooks/useEscapeKey.ts`, `hooks/useFocusTrap.ts`, `hooks/useBodyScrollLock.ts` | the reader overlay |
| Card badge | `components/ModelBadge.tsx:12-24`, placed at `components/MomentCard.tsx:589-596` | a `zine` badge |
| Discovery filter wiring | `app/api/timeline/route.ts:226-237, 964-969`, `lib/discoverState.ts:18, 109-116`, `components/DiscoverFilters.tsx:493-499` | one more kind, three edits (the `Record` at `:493` is a compile error until added) |
| Self-hosted runtime assets at install | `scripts/copy-ffmpeg-core.mjs`, `.gitignore` (`/public/ffmpeg-core/`) | `scripts/copy-pdfjs-assets.mjs` → `public/pdfjs/` |
| Bundle guard and the dynamic-import trick | `scripts/check-bundle-size.mjs:31-33` (10 %), `GLB_3D_VIEWER_DESIGN.md:166-179` | pdf.js and the reader load behind the tap |
| Private, gated, versioned PDF storage | `lib/collectorFileTypes.ts:40-49` (kind `pdf`, 64 MiB), `lib/collectorFileCore.ts:155` (`%PDF-` magic), `app/api/collector-file/route.ts:128-327` (PUT), `view/route.ts:66-118` (gated byte serve), `lib/collectorFileFanout.ts` (update notifications) | the collectors-only mode, as is |
| The one place that says "no PDF viewer" | `lib/collectorFileTypes.ts:51-56` (`CFILE_VIEWABLE_KINDS = ['glb','svg']`), pinned by `scripts/verify-collector-file.ts:167,171` | flips to include `pdf` |
| The collector-facing card and viewer | `components/CollectorFileCard.tsx:252-292` ("view" only for viewable kinds), `components/CollectorFileViewer.tsx:51-102, 170-198` | "Read" for holders; the viewer hands PDF bytes to the reader instead of an `<img>` |
| CSP (report-only) | `next.config.mjs:19-32`: `worker-src 'self' blob:`, `script-src … 'unsafe-eval' blob:`, `connect-src 'self' https:` | pdf.js's worker and wasm decoders need nothing new today |
| The proxy's byte-range contract | `app/api/img/route.ts:510-531` + `lib/media/rangeContract.ts` | the v2 progressive-open path (§6.3) |

Two oracles pin today's behaviour and must flip with the feature:
`scripts/verify-model-media.ts:101-102` ("mint gate: a pdf is REJECTED") and
`scripts/verify-collector-file.ts:171` ("pdf became viewable without a
viewer").

---

## 3. The two modes

```
                         ┌───────────── mint form ─────────────┐
                         │  PDF picked → magic, size, pages    │
                         │  page 1 (or chosen page) → cover    │
                         │  optional cover image upload        │
                         │  mode: public | collectors-only     │
                         └──────┬───────────────────┬──────────┘
                                │                   │
           PUBLIC               ▼                   ▼         COLLECTORS-ONLY
   Arweave (permanent, public)                   Arweave: cover JPEG only
     cover.jpg  zine.pdf                         metadata: image = cover,
   metadata: image = cover,                        kismet_zine{pages, access:'collectors'}
     animation_url = pdf,                        after mint: PUT /api/collector-file
     content{uri: pdf, mime: application/pdf},     (bytes in Redis, kind 'pdf', pages)
     kismet_zine{pages, access:'public'}
                                │                   │
   detail view: cover + "Read · 16 pages"        detail view: cover + collector card
     tap → owned download (gateway walk,           holders: "Read · 16 pages" + "download"
     proxy last) → reader                          non-holders: "collect to read"
                                                   tap → GET /api/collector-file/view → reader
   feed / OG / embeds / covers: cover JPEG       feed / OG / embeds / covers: cover JPEG
   other marketplaces: cover (PDF ignored)       other marketplaces: cover
```

**What is public in each mode.**

| | Public | Collectors-only |
|---|---|---|
| The pages | on Arweave, forever, readable by anyone, anywhere | in Kismet's private Redis store; served only to a session that holds an edition (`lib/collectorFileGate.ts:111-126`: grace marker, then an on-chain balance across the identity's wallets) |
| The cover | on Arweave | on Arweave |
| "First page as cover" | the first page is on Arweave twice (in the PDF and as the cover) | **the first page becomes public** as the cover JPEG; the form says so, and the artist can upload a different cover instead |
| The filename | the `File-Name` tag is public (`lib/arweave/uploadFile.ts:34-37`) | normalized server-side (`lib/collectorFileCore.ts:235-247`) |
| Replace later | no (Arweave is immutable; a new PDF is a metadata edit pointing at a new upload) | yes: versions, rollback, 3 versions of bytes retained, collectors notified (`lib/collectorFileCore.ts:381-415`, `lib/collectorFileFanout.ts`) |
| Delete / takedown | hide from feeds only (`kismetart:hidden-moments`); bytes stay | a real deletion (`planDetach`) |
| Who can read | everyone, including on other marketplaces' "open original" | holders, signed in, on Kismet |

**Why "private" cannot live on Arweave.** Arweave is a public permanent
store; a private file there needs encryption, and the collector-file feature
already went through that design and threw it out in favour of Redis
(`COLLECTOR_DOWNLOADS_DESIGN.md`, "STORAGE PIVOT (2026-08-27)": no master key,
no key-loss risk, real deletions, instantly servable). The answer to
Luciano's question 2 is therefore exactly what the feature already does:
**in collectors-only mode only the cover goes to Arweave, and the PDF goes
where collector files go.** Nothing new is invented for privacy.

**Why the same reader for both.** The reader takes bytes. Where the bytes come
from (an owned gateway download, or the collector-file view route) is the only
difference, and both already exist as fetch paths.

---

## 4. Is "PDF on Arweave, render the whole thing" right?

**Yes, with three qualifications:** the PDF is the artifact; the browser
rasterizes it one page at a time, not all at once; and the size discipline has
to be tighter than the 420 MB media cap sized for video.

### 4.1 The PDF as the artifact

- **It is what Arjan makes.** One upload, no conversion he has to understand,
  and the object on Arweave is the object he would hand a collector or a print
  shop.
- **It outlives Kismet.** `ar://<txid>` to a PDF is readable by any device
  forever with no Kismet code. A pages manifest in a custom key is readable
  only by us.
- **It degrades correctly off-platform.** `image` is a real cover JPEG, so
  OpenSea, Zora and wallets show the cover and ignore an `animation_url` type
  they do not list.
- **Collectors get the real file.** "Download PDF" on a public zine is a link;
  on a private zine the collector-file download already serves PDFs.

### 4.2 Rasterize in the browser, one page at a time

pdf.js parses in a Web Worker and draws any requested page to a canvas. The
reader renders the page in view and its neighbours, converts each finished
canvas to a compressed image, and drops the canvas. That turns the PDF into
exactly what decision 1 asks for — a page-by-page image sequence — without
storing N images anywhere.

| | Pre-rasterize at mint (N images on Arweave) | On demand in the browser (chosen) |
|---|---|---|
| Uploads per zine | 1 PDF + N page images (+ manifest) | 1 PDF + 1 cover |
| Mint-time cost on a phone | N renders + N uploads, each a Turbo sign call (`sign-calls` quota 200/day, `lib/userQuota.ts`); 420 pages is minutes, and a tab eviction mid-way is a half-minted zine | 1 render (the cover) |
| Arweave spend | ~2× (the page JPEGs duplicate the PDF's own JPEGs) | the PDF once |
| Zoom sharpness | fixed at the rasterized width | re-render at a higher scale on zoom; typed/vector pages stay crisp |
| Viewer | an `<img>` carousel | the same carousel plus a ~400-line rasterizer wrapper |
| Off-platform | Kismet-only manifest | the PDF itself |
| Inner-page thumbnails in feeds | free | needs a server renderer (§4.3 C) |

### 4.3 The alternatives, and why they lost (for v1)

- **C. Server-side page renderer** (`/api/pdf-page?u=ar://…&p=3&w=1200`:
  pdf.js in Node plus `@napi-rs/canvas`, CDN-cached). The simplest client, and
  the only way to get OG cards or feed thumbnails of *inner* pages. Not for
  v1: a native canvas binding in the ARM64 Alpine image, CPU and memory on the
  one Oracle box `OPS_RUNBOOK.md` lists as OOM-prone, and a CDN in front of
  `/api/*` that is still an open ops item (`OPS_RUNBOOK.md §3`). It is the
  natural **v2** and this design keeps the door open: the images the client
  makes are the images that route would make.
- **D. HTML wrapper as `animation_url`** (Arjan's Manifold approach). Needs the
  page images anyway, runs in a sandboxed iframe we cannot gate, cannot be
  collectors-only, and he did not like it.
- **E. Native `<embed>`/`<iframe>`.** iOS Safari renders only the first page
  inside a frame (`COLLECTOR_DOWNLOADS_DESIGN.md:1262-1264`), there is no
  page-by-page UX, nothing can be gated. The *top-level* native viewer is still
  useful: "Open PDF" in a new tab is the fallback where the reader cannot run.
- **F. A different engine.** PDFium-wasm (`@embedpdf/pdfium`, 4–6 MB wasm,
  main thread) or MuPDF.js (8–10 MB, AGPL). pdf.js is Firefox's engine,
  Apache-2.0, ~150 KB gzipped on the critical path, parses and decodes off the
  main thread, and ships small wasm decoders for the scanned-PDF codecs. It is
  the one with the most eyes on malformed input.

---

## 5. The reader — "reading a magazine", designed

### 5.1 What the research says

Across magazine and comic readers the conventions that survive on phones are
consistent (3D Issue's mobile-magazine UX notes; NOOK Comics' Zoom View;
Mihon's and YACReader's reader settings; the Macworld iPad redesign
post-mortem; Flipster's progress bookmark):

1. **Horizontal paging with swipe, plus tap zones.** Edge taps advance; a
   centre tap toggles the chrome. The Macworld redesign that replaced article
   swiping with page-turns was the one readers rejected — but a zine *is*
   pages, not articles, so page-turn is the right model here.
2. **Double-tap to zoom, pinch to zoom, paging suspended while zoomed.** NOOK,
   YACReader and Mihon all do this; it is the gesture people already have.
3. **A visible position.** "3 / 16" and a scrubber.
4. **Spreads only when the screen is wide.** Phones show one page; a landscape
   tablet or desktop shows two, cover alone, as a stapled booklet opens.
5. **No page-curl.** Flipbook vendors sell it; it is slow on phones and reads
   as a gimmick. A flat slide with a paper shadow fits a typewritten,
   photocopied zine better than a simulated curl.
6. **Fallback to native.** When the in-page reader cannot run, hand the device
   the PDF.

### 5.2 Entry

The artwork page shows the cover exactly as any still. Feed cards, OG cards,
embeds and collection covers never load pdf.js. On the detail view the media
slot shows the cover with a `Read · 16 pages` button (the `view in 3D`
affordance at `components/MomentModel.tsx:324-344`, re-skinned); tapping the
cover does the same instead of opening the zoom lightbox (`isZoomable` at
`components/MomentDetailView.tsx:1443` excludes the new kind, as it excludes
`model`).

- **Public:** the tap starts the owned download and opens the reader with the
  cover shown as page 1 while bytes arrive, with the byte readout
  (`modelLoadReadout`, "1.2 of 2.3 MB") the 3D viewer already uses.
- **Collectors-only:** the collector card (`components/CollectorFileCard.tsx`)
  shows `Read · 16 pages` next to `download` for holders; the same reader opens,
  fed by `/api/collector-file/view`. Non-holders see the page count and
  "collect to read".

### 5.3 Full-screen overlay, not the media slot

The media column is `aspect-square` (`MomentDetailView.tsx:1652`); a portrait
page inside it would be ~60 % of a phone's width. The reader takes the
viewport like the lightbox (`z-[200]`, near-black backdrop), closes on Esc, the
X, or the browser back gesture, locks body scroll, traps focus. It is portaled
to `document.body` so it also sits above the in-app overlay route
(`components/ModalOverlay.tsx`, whose own z-60 X and Escape listener would
otherwise fight it — the collector-file viewer has that bug today, §17).

### 5.4 Navigation

| Input | Action |
|---|---|
| Swipe left / right | next / previous page (or spread) |
| Tap left third / right third | previous / next |
| Tap centre | show / hide chrome (auto-hides after ~2 s) |
| ← →, Space / Shift-Space, PageDown / PageUp | next / previous |
| Home / End | first / last |
| Scrubber (`<input type="range">`) | jump; the counter follows live |
| Double-tap / double-click | zoom 2.5× at the tap point; again to reset |
| Pinch / ctrl-wheel | zoom 1×–4× |
| Drag while zoomed | pan; paging is suspended until zoom resets |
| Esc / X / back | close |

### 5.5 Layout

Fit-to-viewport per page (contain). A **spread** is shown when the viewport is
landscape and at least ~900 px wide: cover alone, then 2–3, 4–5, …, the back
cover alone, with a toggle to force single pages. Pages of different sizes
each fit their own slot. Reading direction is left-to-right in v1; a
right-to-left artist flag is a one-field addition later (§11.3).

### 5.6 Position

The URL carries `?page=N` (`history.replaceState` as the reader moves), so a
page can be shared and the reader opens there. The last page read is remembered
per token in `localStorage` and resumed.

### 5.7 Loading and rendering

- **Order:** the page in view, then ±1, then ±2. One `page.render` at a time so
  the worker is never saturated by a fast flip; a flip past an in-flight page
  cancels its `RenderTask`.
- **Canvas → image:** every finished canvas is converted to a blob (JPEG 0.9;
  WebP where `toBlob` supports it) and the canvas is zeroed
  (`width = height = 0`) before it is dropped. iOS WebKit accounts canvas
  memory against a per-page budget and reclaims lazily; explicit zeroing is
  the documented workaround (WebKit bug 195325). A 1170 × 1560 canvas is
  ~7 MB; the same page as a JPEG is ~300 KB.
- **Cache:** at most five page blobs plus the current zoomed render; evict
  outside the window. On exit: every blob URL revoked, `loadingTask.destroy()`
  so the worker releases the file.
- **Scale:** CSS size × `devicePixelRatio`, capped at 16 M pixels and 4096 px
  on a side (the iOS canvas limits reported against WebKit; pdf.js's own
  viewer caps at 2^25 pixels on desktop). Zoom renders at `min(zoom × base,
  cap)`.
- **First paint:** the cover is on screen at t=0; page 1 from the PDF replaces
  it within ~300 ms of the last byte for a scanned page.

### 5.8 Chrome

Close · `3 / 16` · scrubber · spread toggle (wide viewports) · `Download PDF`
(public zines: the direct gateway URL in a new tab; private zines already have
the collector download) · fullscreen (desktop). Everything else is the page.

### 5.9 Accessibility

`role="dialog"` with focus trap, Esc, labelled buttons, an `aria-live` region
announcing "Page 3 of 16", page images with `alt="Page 3 of <title>"`,
keyboard parity for every gesture, `prefers-reduced-motion` turns the slide
into a crossfade (the app's existing gate, `MomentModel.tsx:73-91`). A
selectable text layer (`getTextContent`) is not in v1: Arjan's pages are scans
with no text, and it adds DOM per page; it is the right follow-up for typed
zines and for search (§11.4).

### 5.10 Errors

A page that fails to render shows an in-place "page could not be rendered"
tile; the reader keeps working. A document that fails to open falls back to
"Open PDF" (public) or "download" (private). Password-protected PDFs are
refused at pick time (§9), so the reader never meets one.

---

## 6. Engine, integration, delivery

### 6.1 pdf.js, verified against the installed package (6.4.299, 2026-10-03)

| Item | Value | Consequence |
|---|---|---|
| License | Apache-2.0 | keep the LICENSE files beside the copied assets |
| Builds | `build/` (modern) and `legacy/build/` (translated + polyfilled) | **use legacy**: its floor is documented (Safari 18, Chrome 125, Firefox ESR, from the project FAQ); the modern build's floor is "latest" |
| Core size | legacy `pdf.min.mjs` 524 KB raw / **151 KB gzip** (modern 459 / 132) | a dynamic import outside the route manifest — the model-viewer trick |
| Worker | legacy `pdf.worker.min.mjs` 1.32 MB raw / **392 KB gzip** | a static file under `public/pdfjs/`, fetched once per session on first open, cached immutably |
| Wasm decoders | `openjpeg.wasm` 251 KB (JPEG 2000), `jbig2.wasm` 104 KB (bilevel scans), `qcms_bg.wasm` 97 KB (ICC), each with a JS fallback pdf.js loads from the same `wasmUrl` | self-host all of `wasm/`: scanner software and Acrobat's "optimize" commonly produce JPX and JBIG2 pages |
| Standard fonts | `standard_fonts/` 820 KB, 16 files | only PDFs that reference the 14 base fonts without embedding them; fetched on demand |
| CMaps | `cmaps/` 1.7 MB, 169 files | CJK encodings only; on demand |
| ICC | `iccs/` 24 KB | on demand |
| Version lock | the API refuses a worker of a different version | copy worker + assets from `node_modules` at `postinstall`, never commit them |
| Engines | Node ≥ 22.13 | matches the container's node 22.22 if a server use is ever wanted (§4.3 C) |
| Browser features used | `Promise.withResolvers` (both builds), `OffscreenCanvas`, `ImageDecoder` (feature-detected), WebAssembly | Safari ≥ 17.4 in practice, 18 per the project; Apple's June 2026 numbers put 93 % of iOS-26-capable iPhones on iOS 18 or 26; the rest get "Open PDF" |
| `isEvalSupported` | removed in 6.x; one `new Function` remains in the worker | fine under today's report-only CSP; an enforced CSP later needs `'wasm-unsafe-eval'`, which model-viewer's Draco/KTX2 wasm already requires |
| `getDocument` options | `data` (a typed array is **transferred** to the worker, so the main thread keeps no copy), `wasmUrl`, `standardFontDataUrl`, `cMapUrl` + `cMapPacked`, `iccUrl`, `useWorkerFetch`, `maxImageSize`, `enableXfa: false`, `onPassword`; `disableRange` / `disableAutoFetch` / `rangeChunkSize` unused in v1 (§6.3) | set once in the loader module |
| Render API | `page.render({ canvas, viewport, annotationMode, background })` → `RenderTask.cancel()`; `page.cleanup()`, `doc.cleanup()`, `loadingTask.destroy()` | the render queue and eviction |
| Scripting | PDF JavaScript runs only if `pdf.sandbox` is loaded; it is not | never executed |
| Annotations | appearance streams drawn on the canvas (`AnnotationMode.ENABLE`); the link/annotation DOM layer is not mounted | a PDF cannot navigate the reader anywhere |
| `web/pdf_viewer.mjs` | 320 KB scrolling document viewer with its own CSS | not used; the paged reader is ~400 lines over the core API and keeps the gesture model ours |

### 6.2 Integration

- **`lib/pdfjs.ts`** — the one loader: `import('pdfjs-dist/legacy/build/pdf.min.mjs')`
  behind a tap or a pick, `GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs'`,
  the asset URLs above, and `openPdf(bytes)` returning the document. Everything
  else imports this, never `pdfjs-dist` directly (the decoder-pinning lesson of
  `lib/media/modelViewerConfig.ts`).
- **`scripts/copy-pdfjs-assets.mjs`** at `postinstall` (beside
  `copy-ffmpeg-core.mjs`): `legacy/build/pdf.worker.min.mjs`, `wasm/*`,
  `standard_fonts/*`, `cmaps/*`, `iccs/*`, LICENSE files → `public/pdfjs/`;
  gitignored like `/public/ffmpeg-core/`. ~4.5 MB on disk, nothing on the
  critical path.
- **`lib/pdfFormat.ts`** — the PDF identity in ONE place (`.pdf`,
  `application/pdf`, the `%PDF-` magic), re-exported into
  `lib/collectorFileTypes` / `lib/collectorFileCore` exactly as
  `lib/glbFormat.ts` is, so the media slot and the collector-download slot can
  never disagree about what a PDF is (`GLB_3D_VIEWER_DESIGN.md`, "New
  modules").
- **`lib/media/pdfMedia.ts`** — caps and gates: `ZINE_MAX_PAGES = 420`,
  `ZINE_MAX_BYTES = CFILE_MAX_BYTES`, `ZINE_SOFT_WARN_BYTES = 16 MiB`,
  `inspectPdfFile(file)` (magic, then pdf.js: page count, page-1 viewport,
  password → refuse), `renderPdfPagePoster(doc, pageNo)` → a JPEG `File` for
  the poster pipeline, `zineMomentFields(...)` → the metadata fields.
- **`components/ZineReader.tsx`** — the reader (§5), `next/dynamic` with
  `ssr: false` like `ModelPreview` (`MomentDetailView.tsx:82`); takes bytes or
  a loaded document, a title, a start page, and callbacks.
- **`components/MomentZine.tsx`** — the detail view's tap-to-load entry
  (`MomentModel` minus WebGL): idle → loading (owned download) → reader.
- **`components/ZinePreview.tsx`** — the mint form's preview: page 1 rendered,
  "16 pages · 2.3 MB", a compact pager to flip through and verify, and "use
  this page as cover".
- **Bundle:** the artwork route baseline is 1,322,504 B (`bundle-baseline.json`);
  the entry button and resolver branch add a few hundred bytes; pdf.js and the
  reader are chunks no route lists. Expect the same +0.3 % the 3D viewer
  measured, and no baseline bump.

### 6.3 Delivery — how the bytes reach the reader

**v1: one owned download, then `data`.** `fetchModelBlob` generalized to
`fetchMediaBlob(urls, { magic })` (`lib/media/modelFetch.ts`), with the
`%PDF-` check in place of `glTF`, over `modelFetchUrls(src)` (proxy-first on
constrained surfaces, proxy as the last fallback everywhere). One request, one
progress bar, abort on exit.

**Why not pdf.js's own range streaming in v1.** pdf.js can open a document
progressively (first page after one or two 64 KB range requests) when the
server advertises `Accept-Ranges` and a length. Direct `arweave.net` cannot be
relied on for either (`VIDEO_PLAYBACK_RCA.md` finding 7: sandbox redirects
with neither), and cross-origin the `Accept-Ranges` header is invisible
without `Access-Control-Expose-Headers`. Our `/api/img` *does* guarantee the
contract (`rangeContract.ts`; 206 synthesis with real totals), but on a
rangeless upstream every mid-file range is served by reading and discarding
from byte 0 at the origin — the exact reason the RCA's "Still open #1" calls
the CDN urgent. Hundreds of 64 KB ranges per zine open would be that problem
multiplied. **Once the CDN fronts `/api/img`** (`OPS_RUNBOOK.md §3`: the full
object cached at the edge, ranges served from cache), progressive opening is a
one-flag change (`url:` through the proxy instead of `data:`), and the first
page of a 60 MB zine arrives in a second instead of after the whole download.
That is the natural v2, and it is why the soft size warning exists (§7).

**Private zines.** `fetch('/api/collector-file/view?…')` with credentials
(the existing viewer's call, `CollectorFileViewer.tsx:68-82`, plus an
`AbortController` and progress it lacks today), then the same `data` path.
`Cache-Control: private, max-age=3600` on that route lets a re-open within an
hour come from the browser cache.

---

## 7. Caps — 420 pages, and a size cap

**Pages: 420, enforced at pick time** in both modes from pdf.js's `numPages`
(the same parse that renders the cover), with copy naming the cap. No server
enforces it for the public path (no server sees a public mint's media today;
`mint-proxy` never fetches `tokenMetadataURI`, and the GLB cap is client-side
too). The private path keeps its server-side byte cap and magic check; the
page count it receives is display metadata (§10).

**Bytes: 64 MiB hard, 16 MiB soft warning, both modes. One number.**

| Why a byte cap at all | |
|---|---|
| v1 downloads the whole file before page 1 | time-to-first-page is proportional to size: 64 MiB on a 20 Mbit/s phone link is ~27 s. The soft warning tells the artist what a phone reader will wait. |
| the file lives in the worker for the whole session | plus decoded pages; the iOS Mini App webview is where this codebase has already met OOM kills (MomentCard's GIF decoders; the 3D cap rationale at `lib/media/modelMedia.ts:16-32`) |
| the private store is capped at 64 MiB already | `CFILE_MAX_BYTES`; one ceiling means switching an artwork between modes never hits a different wall, and every size string derives from one constant through `formatCfileSize` |
| the 3D fetch cap is 64 MiB already | `MODEL_FETCH_MAX_BYTES`; the shared download helper carries the same ceiling |
| it bounds Arweave spend per mint | the platform pays (proxy signer, `app/api/sign/route.ts`; `paidBy` credits); Turbo prices by bytes at the network rate (ArDrive's last published chart, April 2024, ~$25/GB; `prices.ardrive.io` quotes live). 64 MiB is cents to a couple of dollars; 420 MB is not. Today a 420 MB *video* has the same exposure, so zines reduce it. |
| the 420 MB media cap is a video number | video streams by range and never sits whole in memory; a parsed document is a different animal — the argument `modelMedia.ts` already made for GLB |

**Why not lower.** 420 scanned pages at ~150 KB each is ~63 MB. The page cap
and the byte cap describe the same zine; a lower byte cap makes the page cap
unreachable. Arjan's issue is 2.3 MB.

**Why no minimum.** A one-page PDF is allowed (a broadsheet, a poster); the
form hints that a single page mints better as an image.

**Per-page guard.** `maxImageSize` on `getDocument` bounds the decode of a
pathological embedded image (a 20k × 20k scan) independently of file size.

**Quotas already in play for the private path** (`lib/userQuota.ts:82-93`):
`cfile-upload` 15/day, `cfile-bytes` 256 MiB/day (four max-size zines),
`cfile-view` 400/day per reader identity. The global storage ceiling
(`CFILE_STORAGE_CEILING_BYTES`, default 512 MiB) holds two max-size artworks
with their retained versions; `OPS_RUNBOOK.md §5` already says to raise it to
2 GiB.

---

## 8. Metadata shape and degradation

### 8.1 Public

```json
{
  "name": "trpplzine issue #1",
  "description": "…",
  "image": "ar://<cover.jpg>",
  "animation_url": "ar://<zine.pdf>",
  "content": { "uri": "ar://<zine.pdf>", "mime": "application/pdf" },
  "kismet_thumbhash": "…",
  "kismet_zine": { "pages": 16, "access": "public" }
}
```

The video/model binding verbatim (`MintForm.tsx:1355-1361`: one more term in
the `animationUri` condition; `animationMime` is `application/pdf` because the
picked `File.type` is), so the cross-reload resume path that rehydrates only
`mediaType` (`:1121-1140`) binds identically with no new state. `kismet_zine`
is the discovery and badge signal (a page count without fetching the PDF);
rendering keys on `content.mime`, never on the hint.

### 8.2 Collectors-only

```json
{
  "name": "…", "description": "…",
  "image": "ar://<cover.jpg>",
  "kismet_thumbhash": "…",
  "kismet_zine": { "pages": 16, "access": "collectors" }
}
```

An image moment to every resolver and marketplace. The reader is reached
through the collector-file descriptor (`kind: 'pdf'`), which is the live
truth; the hint only lets cards say "zine · collectors" without a fetch, and
is harmless if the artist later detaches the file (the card then shows no
file).

### 8.3 Resolver

`lib/media/resolveMomentMedia.ts`: a `pdf` branch between `model` (`:99-107`)
and `gif`, keyed on `content.mime === 'application/pdf'` or a `.pdf`
extension on `animation_url`, returning `{ kind: 'pdf', src: cover, pdfSrc }`
with the `image === pdfSrc` guard (`:105`'s twin). **`src` is the still** — the
decision the GLB record calls "the single most important choice": `MarketOvals`,
`CustomizePanel`, the profile-theme route and the share-image path all read
`src` as an image, so a surface that never learns about zines renders a
correct cover rather than feeding PDF bytes to `<img>` or `sharp`.

Degradation, traced:

| Client / consumer | Sees | Because |
|---|---|---|
| An un-upgraded Kismet client, public zine | the cover, zoomable | today's resolver: `application/pdf` vetoes the video guess (`:155-156`), `.pdf` is in `NON_VIDEO_EXT` (`:161`), falls to `image` with `src = meta.image` |
| A stale `/timeline` row with `content: null` | **a video attempt** on `ar://<pdf>`, poster = cover | the ambiguous branch (`:146-165`); `MomentVideo`'s `onAllError` → poster. The same exposure video has (`VIDEO_PLAYBACK_RCA.md` finding 1); the new `pdf` branch keys on the mime *and* the hint, so an upgraded client is immune, and the hint survives the indexer dropping `content` |
| Metadata with no `image` | `kind: 'image'`, `src = ar://<pdf>` → broken `<img>` | the degenerate case; the pick-time rule "no cover, no mint" (§9) prevents it for Kismet mints exactly as the 3D rule does |
| OpenSea / Zora / wallets | the cover | they ignore `animation_url` types they do not list |
| `/api/img?u=ar://<pdf>&w=…` | streamed bytes, not resized | after the §12 guard; our client never asks for it |

---

## 9. The mint form, step by step

1. **Pick.** The drop zone accepts `.pdf,application/pdf` (`MintForm.tsx:1879`)
   and the copy becomes "image, video, gif, 3D, text, PDF zine" (`:1855-1856`).
   `checkMintMedia` (`lib/media/mintMedia.ts:41-75`) gains, before the
   extension fallback: `%PDF-` at offset 0 (the collector-file detector's rule,
   `lib/collectorFileCore.ts:155`) → size > `ZINE_MAX_BYTES` → reject with
   "Zines are capped at 64 MB — this one is 71.2 MB"; else `inspectPdfFile`:
   pdf.js opens the bytes (lazy-loaded on first PDF pick), `onPassword` →
   reject "Password-protected PDFs can't be read by collectors — export it
   without a password", `numPages > 420` → reject "Zines are capped at 420
   pages — this one has 512", else `{ ok: true, kind: 'pdf', pages, firstPage }`.
   The verdict is remembered by identity like `modelPickRef` (`:305, :374`),
   because `File.type` alone must not drive the binding.
2. **Soft warning.** Over 16 MiB, the `[file]` effect's toast
   (`:358-366`'s pattern): "Large zine — readers on phones download the whole
   file before the first page; under 16 MB keeps that under a few seconds."
3. **Preview.** `ZinePreview` in the slot (`:1790-1839`): page 1 rendered,
   "16 pages · 2.3 MB", ← → to flip through and verify the order, and
   `use this page as cover`. The posed-model precedent ("the framing of a 3D
   work is an authored decision", `GLB_3D_VIEWER_DESIGN.md §4`) applies: the
   cover is the page the artist lands on, page 1 by default.
4. **Cover.** The poster is the chosen page rendered at ~1200 px on the long
   edge to JPEG 0.85 (`ModelPreview.tsx:47-48`'s `POSTER_MIME`/`POSTER_QUALITY`),
   on white (pdf.js's default page background), as a `File` → the existing
   `generateThumbhash(posterFile)` + poster upload. **Optionally** an uploaded
   image replaces it: a `cover` picker through `checkCoverImage`
   (`mintMedia.ts:82-88`, "a still image or a gif"). The mint form has no
   cover picker today (only the edit flow does, `MomentDetailView.tsx:314-328`);
   this adds one, shown only for a PDF pick.
   **No cover, no mint**: if rendering fails and no image was uploaded, the
   pick is refused ("Could not render the first page — try re-exporting the
   PDF"), as a posterless 3D mint is refused (`:1212-1217`). A zine with no
   `image` is invisible on every static surface.
5. **Mode.** A control shown only for a PDF pick, defaulting to **public**
   (open question §18.2):
   - *Everyone can read* — "the PDF is stored on Arweave: public and permanent."
   - *Collectors only* — "stored privately on Kismet; only the cover is public
     (your first page, unless you upload a different cover); you can replace
     the file later and collectors are notified."
   In collectors-only mode the PDF *is* the collector download: the existing
   staged-file slot (`:2426-2478`, `cfileFile`) is filled with it and the slot
   is hidden. In public mode the slot stays available for something else, with
   the 3D-case hint ("the zine itself is public — gate something it doesn't
   give away: a print-res export, the source scans").
6. **Upload and metadata.**
   - Public: media upload (`uploadToArweave(mediaFile)`, tagged
     `application/pdf` by `File.type`, `uploadFile.ts:34-37`) → poster upload →
     metadata (§8.1) → mint. The sequencing is today's (`:1279-1298`).
   - Collectors-only: poster upload → metadata (§8.2) → mint → the existing
     `attachStagedCfile` PUT (`:477-506`, fired at `:1587`) with the PDF plus
     `?pages=16`.
7. **After the mint.** Public: nothing new. Collectors-only: the PUT is
   fire-and-forget today ("Minted, but the download didn't attach — add it
   from the artwork page"). For a zine that failure leaves a cover with no
   pages, so the zine path **awaits** the PUT with one retry before "Minted!",
   and keeps the manage panel as the recovery path.
8. **Edit flow** (`MomentDetailView.tsx:1059-1431`): accept list (`:1919`),
   the gate verdict and pick identity (`:274-289`), a required page poster for
   a PDF pick (`:1205-1223`'s model branch, twinned), `content.mime` at the
   resume site (`:1127`, which assumes "a model is the only non-MP4 animation
   here"), a `pdf` option in the re-point type buttons (`:1960`, which today
   writes `video/mp4` for anything but gif/image), `kismet_zine` carried
   through `newMetadata` (`:1305-1315` rebuilds from scratch and drops unknown
   custom fields — `kismet_bg` was once lost exactly this way, `:1076-1078`),
   and the cover picker as it is. Switching a public zine to collectors-only
   after mint = a metadata edit that drops `animation_url`/`content` plus a
   collector-file attach; the reverse = an attach to Arweave plus a metadata
   edit. Both are compositions of existing operations; neither needs new
   routes.

---

## 10. Collectors-only specifics

Changes to the collector-file feature, all small:

| Change | Where | Note |
|---|---|---|
| `pdf` joins the viewable kinds | `lib/collectorFileTypes.ts:51-56` | the comment that deferred it ("would cost a pdf.js dependency for convenience alone") is now false; rewrite it to say the public zine paid for the dependency |
| `pages` on the version record | `lib/collectorFileCore.ts:253-279` (type), `:387-399` (`planAttach` builds the version field by field), `lib/collectorFile.ts:115-129` (public descriptor), `app/api/collector-file/route.ts:168-177` (read `?pages=`, bounded 1..420) | display metadata like `note`; the oracle pattern at `verify-collector-file.ts:207-208` (kind survives attach/history) is the one to copy |
| The view route serves `pdf` | `app/api/collector-file/view/route.ts:88-90` | headers stay exactly as they are: real MIME, `attachment`, `nosniff`, `private, max-age=3600` — a `fetch()` reads an attachment fine, and a direct navigation still saves rather than renders on our origin |
| The card | `components/CollectorFileCard.tsx:216-281` | header gains "· 16 pages"; `view` becomes `read` for `pdf`; non-holders see "collect to read" |
| The viewer | `components/CollectorFileViewer.tsx:170-198` | `pdf` mounts `ZineReader` with the fetched bytes instead of falling into the `<img>` branch it would hit today; the fetch gains an `AbortController` and progress (it has neither, `:51-102`) |
| The manage panel | `components/CollectorFileManagePanel.tsx:75-86` | counts pages on pick (lazy pdf.js) for the cap and the PUT; shows "PDF · 16 pages" |
| Copy | `route.ts:193` ("upload a zip, PDF, GLB or SVG" omits ROMs), `MintForm.tsx:2442` (omits SVG) | fix while there |

Unchanged and reused: the gate (`lib/collectorFileGate.ts:111-126`), quotas
(`cfile-view` 400/day; a read is one view unit, never a download unit, so it
does not clear the "update available" badge — the design doc's row 9
`viewedV` marker remains a follow-up), the kill-switch, versioning with
rollback, the fan-out notification (`CFILE_FANOUT_CEILING = 2000`,
`FANOUT_BATCH = 50`), the storage ceiling, the Traefik read-timeout
obligation for 64 MiB PUTs (`OPS_RUNBOOK.md §5`).

**Gaps that stay open in v1** (recorded, not solved here): the view route is
session-only, so a holder whose holding wallet is not the session's and not
linked gets `403 "verify with the holding wallet"` with no wallet-proof
fallback (download has one via tickets, `CollectorFileCard.tsx:101-143`); the
client-side "am I a collector" is the connected wallet's `balanceOf`
(`MomentDetailView.tsx:353-361`), narrower than the server's identity union. A
ticket-accepting view route is the fix for both, and it is its own change.

---

## 11. Every component and option

### 11.1 Surfaces — what each does today, what a zine needs

| Surface | Today (how `model` is treated) | Zine |
|---|---|---|
| `lib/media/resolveMomentMedia.ts:4, 83-174` | `src` = still, `modelSrc` = GLB | `kind: 'pdf'`, `src` = cover, `pdfSrc` (§8.3) |
| `components/MomentCard.tsx:661` (kinds that render `src`), `:589-596` (badge) | `image \| gif \| model` + `ModelBadge` | add `pdf`; a `ZineBadge` ("zine", BookOpen icon, `aria-label="zine, 16 pages"`) in the same corner logic |
| `components/FeaturedMoment.tsx:410`, `components/PatronArtworkShowcase.tsx:82` | **`image \| gif` only — a model falls to the thumbhash blur** (§17.1) | add `pdf` to both whitelists (and `model`, which should have been there) |
| `components/MarketOvals.tsx:201` | `image \| model` → `src` | add `pdf` |
| `components/CustomizePanel.tsx:46-57`, `app/api/profile/[address]/theme/route.ts:132-136, 146-151` | model reads `resolved.src` | add `pdf` to the model branches |
| `components/MomentDetailView.tsx:1443, 1641-1733` | `isModel` → `MomentModel`; not zoomable | `isZine` → `MomentZine`; not zoomable; the card beneath for collectors-only |
| Lightbox `:2556-2583` | image/gif only | unchanged; the reader is its own overlay |
| `components/MarketCard.tsx:83-84`, `lib/listings.ts:43-50` | `contentMime` carried; no model badge | optional badge on `contentMime === 'application/pdf'`; `image` is already the cover |
| `components/AirdropForm.tsx:394-416` | renders `meta.image` | nothing |
| `components/CollectionView.tsx:689-696` | collection `image` else first moment's `image` | nothing (the cover is `image`) |
| `app/artwork/[address]/[tokenId]/page.tsx:340-395` | JSON-LD mime; video preload | nothing; no preload of the PDF (it is behind a tap) |
| `lib/structuredData.ts:219-224` | `hasAnimation` → "Digital video" (so a model says video) | `application/pdf` → "Digital document" ahead of the `hasAnimation` fallback; `scripts/verify-structured-data.ts:93-126` gains a row |
| `app/artwork/[address]/[tokenId]/opengraph-image.tsx:67-75` | any `animation_url` → `VIDEO` label on the text-only fallback card | a `ZINE` label ahead of that rule |
| `lib/media/shareImage.ts:31-45`, `lib/media/animatedPreview.ts:675-690` | image === animation guard; video/gif only | nothing while `image` is the cover |
| `app/api/img/route.ts:300-315` | `model/` skips sharp | `application/pdf` skips sharp (§12) |
| `app/api/timeline/route.ts:226-237, 964-969`, `lib/discoverState.ts:18, 109-116`, `components/DiscoverFilters.tsx:493-499` | `model` → chip "3D" | `pdf` → chip "zines" (§11.5) |
| `lib/agent/mintMedia.ts:26-29, 82-86`, `lib/agent/mint.ts:29, 56-96`, `lib/agent/summary.ts:152`, `app/api/agent/prepare-mint/route.ts:89-93` | a `model` kind with a required poster | **later**: a `pdf` kind with a required cover; the `KIND_LABEL` record is a compile error until added, so it is a deliberate choice to leave the agent path for a follow-up |
| `lib/experience/frameUpload.ts:51-54, 81` | refuses `model` explicitly; **any other new verdict falls into the still-image `else`** | add an explicit refusal for `pdf` ("Use an image, a gif or a video") — a one-line hazard otherwise |
| `components/CollectorFileCard.tsx`, `CollectorFileViewer.tsx`, `CollectorFileManagePanel.tsx` | glb/svg viewable | §10 |

### 11.2 Artist-side options

| Option | v1 | Notes |
|---|---|---|
| Public vs collectors-only | **yes** | §9.5; default public (§18.2) |
| Cover: page of choice | **yes** | from the preview pager; page 1 default |
| Cover: uploaded image | **yes** | `checkCoverImage` |
| Page count and size shown before mint | **yes** | "16 pages · 2.3 MB" |
| Replace the file after mint | collectors-only: **yes** (existing versioning + notify) | public: a metadata edit pointing at a new upload |
| Release note on replace | collectors-only: **yes** (existing, 140 chars) | — |
| Collector download alongside a public zine | **yes** (existing slot) | e.g. a print-res export |
| Reading direction (RTL) | later | one flag in `kismet_zine`; manga, Hebrew, Arabic zines |
| Spread hint (cover alone / first page is a spread) | later | one flag; the default booklet logic covers stapled zines |
| Preview pages for non-collectors | later | N public page renders at mint (the cover's path, repeated), an `access: 'preview'` field, the card shows them; a classic comic-store pattern |
| Issues as a series | **yes, by composition** | a collection per zine ("trpplzine"), each issue a mint; the collection cover is the latest cover |
| Switch mode after mint | **yes, by composition** | §9.8 |

### 11.3 Reader-side options

| Option | v1 | Notes |
|---|---|---|
| Swipe / tap zones / keyboard / scrubber | **yes** | §5.4 |
| Spreads on wide screens, with a toggle | **yes** | §5.5 |
| Double-tap and pinch zoom, pan | **yes** | §5.4 |
| Page deep link, resume | **yes** | §5.6 |
| Download / open in native viewer | **yes** | public: direct gateway link; private: the download card |
| Fullscreen | **yes** (desktop) | `requestFullscreen` on the overlay |
| Reduced-motion | **yes** | crossfade |
| Vertical scroll mode | later | some readers prefer it on phones; the page images already exist |
| Thumbnail strip / table of contents | later | pdf.js `getOutline()` is free when a PDF has one; zines rarely do |
| Selectable text, find in zine | later | `getTextContent`; needs typed or OCR'd PDFs |
| Page labels (roman numerals, "cover") | later | `getPageLabels()` |

### 11.4 Platform

| Item | v1 | Notes |
|---|---|---|
| Card badge "zine" + page count | **yes** | §11.1 |
| `/api/img` guard | **yes** | §12 |
| Structured data "Digital document" | **yes** | §11.1 |
| OG label | **yes** | §11.1 |
| Discovery filter chip | **yes, cheap** | §11.5 |
| Analytics | later | the funnel counters (`ANALYTICS.md`, `kismetart:funnel:<event>:<day>`) can take `zine_open` and `zine_read_complete` (last page reached); one line each, once the reader exists |
| Agent (MCP) mint path | later | §11.1 |
| Server page renderer (inner-page OG/thumbnails) | later | §4.3 C, after the CDN |
| Progressive open via ranges | later | §6.3, after the CDN |
| Sitemap / SEO | nothing | the artwork page is unchanged; "Digital document" helps |

### 11.5 Filter: yes, and here is where

The chip costs three edits (the GLB precedent, `GLB_3D_VIEWER_DESIGN.md §7`)
and the server filter is already kind-agnostic (`app/api/timeline/route.ts:964-969`
classifies through `resolveMomentMedia`). Add `pdf` to the allowlist
(`:226-237`), to `MediaKind` and its parser (`lib/discoverState.ts:18, 109-116`),
and `pdf: 'zines'` to `MEDIA_LABEL` (`DiscoverFilters.tsx:493-499`), which is
where the chip appears: Discover's media row, next to "3D". Collectors-only
zines are image moments to the resolver, so the chip would miss them unless
the timeline filter also admits `kismet_zine?.access === 'collectors'`; that
is one more `||` in the same filter and is why the hint exists in both modes
(§8.2). Recommendation: ship the chip in Phase 3, with both modes admitted.

---

## 12. Security and abuse

- **PDF JavaScript never runs.** The core API has no script engine; the
  sandbox module is not loaded. `OpenAction`, form scripts, and link
  annotations are inert (the annotation DOM layer is never mounted).
- **No navigation out of the reader.** Links in the PDF do not exist as DOM.
- **Embedded files** (`/EmbeddedFiles`) are never exposed (`getAttachments` is
  not called).
- **XFA** is off (`enableXfa: false`).
- **Fonts.** pdf.js sanitizes embedded font programs before handing them to
  `FontFace`, as it does in Firefox; the `useSystemFonts` default is fine.
- **Decoders run in wasm** in the worker; a malformed JPX/JBIG2 stream fails a
  page, not the app.
- **Pathological pages.** `maxImageSize` bounds decode cost; the per-page
  render has a watchdog ("page could not be rendered"); the worker is off the
  main thread, so a spinning parse never freezes the UI, and `destroy()`
  terminates it on exit.
- **`/api/img`.** Add `application/pdf` to the non-resizable types
  (`route.ts:305-314`) so a hand-crafted `?w=` never buffers a 64 MiB PDF into
  sharp's slot (the same reasoning as `model/`). Also send
  `Content-Disposition: attachment` for `application/pdf` on the streaming
  path (`:527-531`), so the proxy never renders a PDF inline on our origin —
  the stance the collector-file routes already take. The reader never navigates
  to the proxy; "Download PDF" / "Open PDF" use the direct gateway URL.
- **Magic at every ingress.** Pick (`inspectPdfFile`), collector-file PUT
  (`detectCfileKind`), reader fetch (`fetchMediaBlob` with `%PDF-`): a gateway
  HTML landing page can never reach pdf.js.
- **Private bytes.** Kept in memory only; blob URLs revoked on exit; never
  written to `localStorage` or IndexedDB. "Collectors-only" is a gate, not DRM —
  a holder can save the file, and the copy should never suggest otherwise.
- **Permanence.** The public mode's confirmation copy says the PDF is public
  and permanent, as other media are; contributor poems are the artist's
  responsibility under the existing terms.
- **Takedown.** Public: hide + blacklist (existing). Collectors-only: real
  deletion + the per-artwork kill-switch (`kismetart:cfile-blocked`).

---

## 13. Ops and cost

- **Arweave.** Platform-paid through the proxy signer and `paidBy` credits;
  bounded per mint by the 64 MiB cap and per identity by `mint` (50/day) and
  `sign-calls` (200/day). A zine is two uploads (PDF, cover) plus the metadata
  JSON (sub-100 KiB, free).
- **Redis** (collectors-only): ~85 MiB resident per max-size version, three
  versions retained → up to ~255 MiB per artwork against the storage ceiling;
  raise `CFILE_STORAGE_CEILING_BYTES` to 2 GiB as `OPS_RUNBOOK.md §5` already
  says. Each read is one view slot (`MAX_CONCURRENT_VIEWS = 2`, ~2.3× the file
  in memory while it streams) — unchanged from GLB views.
- **Traefik.** A 64 MiB PUT needs the 5-minute read timeout the runbook
  describes; nothing new.
- **Static assets.** `public/pdfjs/` ~4.5 MB on disk, served immutably; only
  the worker (392 KB gz) is fetched on a first open, decoders and fonts only
  when a PDF needs them.
- **CDN** (`OPS_RUNBOOK.md §3`, still unapplied): not required for v1; it
  unlocks progressive opening (§6.3) and a server renderer (§4.3 C).
- **No new env vars, no cron, no migration.**

---

## 14. Sequencing

**Phase 0 — fail-safe before the feature (small, ship regardless).**
`application/pdf` guard + attachment disposition on `/api/img`; `pdf` in the
resolver with `src` = cover (an externally minted PDF token, or a stale row,
renders its cover today instead of attempting video); explicit `pdf` refusal in
`frameUpload.ts`; the `FeaturedMoment` / `PatronArtworkShowcase` whitelist fix
for `model` (§17.1). Oracle rows for each.

**Phase 1 — public zines.**
`pdfjs-dist` + `scripts/copy-pdfjs-assets.mjs` + `lib/pdfjs.ts`;
`lib/pdfFormat.ts` shared with the collector-file registries;
`lib/media/pdfMedia.ts` (caps, gate, page count, poster render, metadata
fields); `ZinePreview` + the cover picker + the mode control in `MintForm`
(mode control shipped but collectors-only disabled until Phase 2, or Phase 2
ships first — see §18.1); the binding and metadata; `MomentZine` +
`ZineReader`; `ZineBadge`; `verify-pdf-media.ts`; the e2e script; bundle
check.

**Phase 2 — collectors-only zines.**
`pdf` viewable; `pages` on the record and the PUT; the card's `read`; the
viewer hands bytes to `ZineReader` (with abort + progress); the manage panel's
page count; the mint form's collectors-only route (await the attach); copy
fixes. `verify-collector-file.ts` rows flip and grow.

**Phase 3 — discovery and polish.**
The `zines` chip (both modes); structured data + OG label; deep links and
resume; spreads toggle; "Download PDF"; analytics events; the edit-flow
re-point option.

**Later.** Preview pages; RTL and spread hints; scroll mode; text layer and
find; outline/thumbnails; the agent mint path; progressive open (after the
CDN); a server page renderer for inner-page OG cards (after the CDN); a
ticket-accepting view route.

**Never.** Page-curl animation; pre-rasterizing every page at mint; an HTML
wrapper as `animation_url`; a text-only "zine" mode (writing moments exist).

---

## 15. Verification

- **`scripts/verify-pdf-media.ts`** (pure, in `verify:flows`, modelled on
  `verify-model-media.ts`): the gate (a `%PDF-` file is `kind: 'pdf'`; a PDF
  over 64 MiB, over 420 pages, or password-protected is rejected with the
  named copy; a `.pdf` without the magic is rejected; a typeless PDF with the
  magic is accepted), the resolver shape (`src` = cover, `pdfSrc`, the
  degenerate `image === pdf` guard, precedence against the five existing
  kinds), the fail-safe list of surfaces that read `src`, `zineMomentFields`,
  the constants and every derived copy string, the `kismet_zine` carry-through
  in the edit flow's `newMetadata`. Page counting is injectable (the script
  runs without a browser).
- **Flip the two oracles**: `verify-model-media.ts:101-102` becomes "a pdf is
  ACCEPTED as kind pdf"; `verify-collector-file.ts:167, 171` admit `pdf` and
  pin that `pages` survives `planAttach`, history and rollback (`:207-208`'s
  pattern).
- **`verify-structured-data.ts`**: `application/pdf` → "Digital document".
- **`verify-img-range.ts` / `verify-img-cache.ts`**: `application/pdf` is
  stream-class and carries `attachment`.
- **`scripts/e2e/zine.mjs`** (beside `model-media.mjs`, not in `npm run check`):
  a hand-built multi-page fixture PDF (`make-pdf.mjs`, the `make-glb.mjs`
  precedent — content streams with text and one DCT-encoded JPEG page, plus
  truncated / password / 421-page variants); asserts: no pdf.js chunk and no
  worker before the tap, the reader's first page pixels match the cover, page
  geometry on a 390 × 844 viewport and a 1280 × 800 spread, swipe/keys/scrubber
  move the counter, `?page=` round-trips, at most one live canvas, blob URLs
  revoked on close, the feed card shows the cover and the badge and never loads
  pdf.js, the mint form's cover capture equals a reference render.
- **Bundle:** `npm run check:bundle` must pass with no baseline bump (the
  3D viewer measured +0.26 %).
- **`npm run check`** green before every push, per the GLB record.

---

## 16. Risk register

| # | Risk | Mitigation |
|---|---|---|
| 1 | Time-to-first-page on big zines in v1 (whole-file download) | 16 MiB soft warning naming the phone consequence; 64 MiB hard cap; progressive open after the CDN (§6.3) |
| 2 | iOS canvas memory on long reading sessions | one live canvas, blobs not canvases, explicit zeroing, 16 MP / 4096 px caps, eviction window of five (§5.7); the e2e asserts the live-canvas count |
| 3 | A scanned PDF uses JPX or JBIG2 and the decoders fail to load | all `wasm/` files and their JS fallbacks self-hosted at the one `wasmUrl`; the e2e fixture includes a JPX page if `make-pdf.mjs` can emit one, else a manual check with a scanner-produced file (§18.1) |
| 4 | An old browser cannot run the legacy build | the dynamic import's rejection shows "Open PDF" / "download" instead of a dead button |
| 5 | A stale `/timeline` row with `content: null` makes a public zine attempt video | the `kismet_zine` hint is a second key for the `pdf` branch; the existing poster fallback bounds the cost |
| 6 | The edit flow drops `kismet_zine` | carried in `newMetadata` and pinned by the oracle (the `kismet_bg` lesson) |
| 7 | The collectors-only attach fails after the mint | awaited with a retry before "Minted!"; the manage panel remains the recovery path; the cover + hint show "zine" so the artist notices |
| 8 | Arweave spend from large public zines | 64 MiB cap; smaller than today's video exposure |
| 9 | The reader inside the in-app overlay route fights `ModalOverlay`'s X and Escape | portal to `document.body`, shared `useEscapeKey` / `useFocusTrap` / `useBodyScrollLock`, z-index above the overlay (§5.3) |
| 10 | A holder cannot read because the view route is session-only | recorded in §10; a ticket-accepting view route is the follow-up |
| 11 | A 1-page PDF floods the "zines" filter with posters | allowed, hinted at pick time; revisit if it happens |
| 12 | CSP promoted to enforcing without `'wasm-unsafe-eval'` | breaks model-viewer's decoders too; the promotion checklist in `next.config.mjs` gains the directive |

---

## 17. Found along the way (pre-existing, not caused by this design)

1. **The desktop hero and the Patron showcase drop 3D moments to a blur.**
   `components/FeaturedMoment.tsx:410` and `components/PatronArtworkShowcase.tsx:82`
   whitelist `image | gif` only, while `resolveMomentMedia.ts:26-31`,
   `verify-model-media.ts:13-18` and `GLB_3D_VIEWER_DESIGN.md` all say those
   surfaces render a model's still. They render the thumbhash blur (plus the 3D
   badge on the hero). Phase 0 fixes it with the zine whitelist edit.
2. **A poster-upload failure mints a posterless 3D moment.**
   `MintForm.tsx:1283-1288` catches the poster upload to `null`; nothing
   re-checks `isModelMedia && !posterUri` after the guard at `:1212-1217`. The
   same guard must cover zines; fixing it covers both.
3. **A typeless video previews as `<img>` and mints `image: <video>`.**
   `verify-model-media.ts:124-125` pins that a typeless `.mov` passes the gate
   as video, but `MintForm` branches on `file.type` for the preview (`:1826`),
   the remux/poster (`:1246`) and the binding (`:1356-1357`). Plumbing the
   verdict kind (as this design does for `pdf`) is the fix.
4. **`CollectorFileViewer`**: the model-viewer import and the fetch run one
   after the other despite the comment (`:55-57, :68`); no `AbortController`;
   inside the overlay route it sits under `ModalOverlay`'s X and both Escape
   listeners fire. The reader's shell fixes these for `pdf`; the same shell
   should serve glb/svg.
5. **Stale copy**: `route.ts:193` omits ROMs; `CT_OK` (`:154`) lacks the ROM
   MIMEs; `MintForm.tsx:2442` omits SVG; the design doc's data model says
   `kind: zip|pdf|glb` and claims attach-at-mint is out of v1.

---

## 18. Open questions for Luciano

1. **The PDF.** It did not arrive and is not in Drive. Any route works: a
   Drive share, a link, or dropping it into the repo on this branch. With the
   file I will record its page count, page sizes, image encodings (JPEG vs
   JPX/JBIG2 — this decides whether risk 3 is real for his scanner), text
   layer and linearization, and use it as the e2e fixture.
2. **Default mode.** Public (every other media kind is public; the collect
   incentive comes from the edition) or collectors-only (a stronger reason to
   collect; Arjan's issue #0 was public on Manifold). This design defaults to
   public and makes the choice explicit on every PDF pick.
3. **Phase order.** Public first (Phase 1) then collectors-only (Phase 2), or
   the reverse. Public first builds the reader against Arweave bytes with no
   gate in the way; collectors-only first ships the mode Arjan may actually
   want for a collectible.
4. **Naming.** "zine" as the product word everywhere (badge, chip, copy,
   `kismet_zine`), or something broader ("document", "book", "pages"). The
   metadata key is permanent, so this one is worth a yes/no now.
5. **Cover from any page.** "Use this page as cover" from the preview pager, in
   addition to page 1 and an uploaded image. Cheap; include?
6. **Download link on public zines.** The PDF is public anyway; show
   "Download PDF" in the reader chrome? (Recommended yes.)
7. **Preview pages for non-collectors.** Not in v1; decide now whether to
   reserve the `access: 'preview'` shape so a later addition needs no metadata
   migration. (Recommended yes.)
8. **The "zines" chip** in Discover: Phase 3 as proposed, or with Phase 1.
9. **Analytics.** `zine_open` / `zine_read_complete` funnel events wanted?
10. **One-page PDFs.** Allowed with a hint (as designed), or refused ("mint it
    as an image")?

---

## Appendix A — verified vs. assumed

**Verified in this session.** Every `file:line` above (read from the tree at
`096a705`); the pdf.js package contents, sizes, gzip sizes, build variants,
options, API and engine field (unpacked `pdfjs-dist@6.4.299`); the project
FAQ's browser floor (legacy: Safari 18, Chrome 125, Firefox ESR; modern:
"latest"); Apple's iOS adoption figures (June 2026, via press coverage of
Apple's developer page); the iOS canvas limits (WebKit source and bug tracker,
2019–2022 — older sources, treated as the conservative bound); Turbo's free
tier under 100 KiB and that upload pricing follows the network rate (ArDrive
docs); that the Base-app DM screenshot is not a Kismet surface.

**Not verifiable from this container.** `arweave.net`'s current `Accept-Ranges`
/ CORS headers (the gateway is blocked here; the design routes the v2
progressive path through our proxy regardless); the live Turbo price; Arjan's
actual file; the Manifold page for issue #0.

**Assumed, to be measured on the first build.** The artwork route's bundle
delta (expected ≈ +0.3 %); page-1 render time on a scanned page (expected
≤ 300 ms); WebP support in `toBlob` on the target Safari versions (JPEG is the
universal fallback either way).
