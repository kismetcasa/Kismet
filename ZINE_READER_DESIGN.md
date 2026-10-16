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

> §25 (2026-10-16) refines this section after a second research pass: the
> cover opens into the reader at the tap (5.2, 5.7), pages follow the finger
> (5.4), the chrome hides on the first turn as well as at rest (5.4, 5.8), and
> a page exported as a spread stands alone (5.5). Where the two differ, §25 is
> what ships.

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
otherwise fight it — the collector-file viewer had that bug, §17; fixed in §26).

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
   should serve glb/svg. (The Escape half is fixed for every kind in §26.)
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

## 19. Round 2 — decisions (2026-10-14) and one discrepancy

Luciano's answers to §18, now the spec:

| Question | Decision |
|---|---|
| Default mode | **Public.** |
| Phase order | **Public reader first.** Collectors-only is Phase 2. |
| Naming | **"Zine" everywhere** — badge, copy, chip, the `kismet_zine` key — distinct from the collector-download PDFs. Any PDF may be a zine (a comic, a catalogue): the word is the product, not a content rule. |
| Download on public zines | **Yes**, in the reader chrome, to the gateway URL. |
| Discovery chip | **No chip.** The first filter surface should be a button on the Discover page (the footer's Discover link, `components/SiteFooter.tsx`). Deferred until everything else is complete. What exists there today: `DiscoverMarketView` already carries a "media" pill menu (images / video / gifs / writing / 3D, `DiscoverFilters.tsx:493-541`), so "zines" is a three-line addition to that menu when wanted; a dedicated button is a separate design. |
| One-page PDFs | **Allowed.** The single page is the cover and the only page. |
| Cover | Optional. See the discrepancy below. |

**The cover, and the one discrepancy.** The round-2 answer reads: *"cover
image (optional); if they upload then checked 'use as cover image'; if they
use as cover image, cover is uploaded to Arweave instead of the PDF — this is
more or less the private option but user chosen."* Two things in that do not
fit the rest of the design:

1. **A public zine always uploads a cover JPEG as well as the PDF.** The
   token's `image` must be a still (feed cards, OG cards, other marketplaces
   render nothing else), and a PDF cannot be one. So "cover instead of PDF"
   describes only the collectors-only mode. In public mode the cover is *in
   addition to* the PDF: page 1 rendered at pick time, or an uploaded image.
2. **Coupling "uploaded a cover" to "collectors-only" conflates two
   independent choices.** An artist who wants a nicer thumbnail on a public
   zine would silently make it private, and a collectors-only zine could no
   longer use its first page as the public cover (which decision 4 of round 1
   allowed).

What is built, which honours the intent (simple, user-chosen) without the
coupling: the cover upload is **optional and independent** — upload one and it
is the cover, remove it and the page marked in the preview is; the PDF goes to
Arweave regardless (public mode). Collectors-only, in Phase 2, is its own
explicit choice on a PDF pick, worded for its consequence: *"collectors only —
the zine stays off Arweave; only the cover is public."* No "use as cover"
checkbox: uploading a cover image means using it.

## 20. Implementation record — Phase 0 + Phase 1 (public zines)

What shipped on `claude/dazzling-carson-gdrzti`, and where the reasoning
lives in the code.

| File | Role |
|---|---|
| `lib/pdfFormat.ts` | The PDF identity (`.pdf`, `application/pdf`, `%PDF-`) in ONE place, re-exported into `lib/collectorFileTypes` and `lib/collectorFileCore` — the GLB rule applied to PDF. |
| `lib/media/zineMedia.ts` | `ZINE_MAX_PAGES` (420), `ZINE_MAX_BYTES` (= `CFILE_MAX_BYTES`), `ZINE_SOFT_WARN_BYTES` (16 MiB), the injectable `PdfInspector`, `sniffPdfFile`, `asPdfFile`, `zineMomentFields`, `readZineHint`, and every copy string derived from the constants. Pure. |
| `lib/media/mintMedia.ts` | `checkMintMedia(file, { inspectPdf })` — the `pdf` verdict with its page count; without a parser a PDF is refused (the edit flow and the machine frames pass none). |
| `lib/pdfjs.ts` | The one pdf.js loader: legacy build, dynamic import, worker + wasm + font URLs under `/pdfjs/`, `openPdf` (bytes transferred to the worker), `inspectPdfFile`, `renderPageToBlob` (canvas → JPEG → canvas zeroed, 16 MP / 4096 px caps), `renderZineCoverFile`. |
| `scripts/copy-pdfjs-assets.mjs` | `postinstall` copy of the worker, wasm decoders, standard fonts, CMaps and ICC into `public/pdfjs/` (gitignored), so the worker always matches the installed API. |
| `lib/media/resolveMomentMedia.ts` | `kind: 'pdf'` with `src` = cover and `pdfSrc` = the PDF, keyed on `content.mime`, a `.pdf` extension, or the `kismet_zine` hint when no mime contradicts it; the `image === pdf` guard. |
| `components/ZinePreview.tsx` | Mint-form preview: pages through the PDF, captures the chosen page as the cover file. |
| `components/MintForm.tsx` | PDF pick with the parser, pick identity + page count, the preview, the optional cover upload, the binding (`animation_url` = PDF, `content.mime` = `application/pdf`, `kismet_zine`), the shared "no poster, no mint" guard for models and zines (fixes §17.2), the resumed-session poster re-upload. |
| `components/MomentZine.tsx` | The detail view's tap-to-load entry: owned download (`fetchMediaBlob` with the `%PDF-` check), the engine and the reader chunk fetched in parallel, `?page=` deep link and `localStorage` resume, "open the PDF" fallback. |
| `components/ZineReader.tsx` | The reader: paged, swipe / tap zones / keys / scrubber, spreads on wide landscape viewports, double-tap and pinch zoom with drag-pan, chrome that hides itself, a dialog with focus trap and live page announcements, blobs not canvases, one render at a time, everything revoked on close, "Download PDF", fullscreen. |
| `components/ZineBadge.tsx` | The card badge ("zine", with the page count in its label). |
| `components/MomentCard.tsx`, `FeaturedMoment.tsx`, `PatronArtworkShowcase.tsx`, `MarketOvals.tsx`, `CustomizePanel.tsx`, `app/api/profile/[address]/theme/route.ts` | Render the cover for `pdf` (and, where it was missing, `model` — §17.1 fixed). |
| `app/api/img/route.ts` | `application/pdf` never enters the resize path and is served as an attachment. |
| `lib/experience/frameUpload.ts`, `lib/structuredData.ts`, `app/artwork/[address]/[tokenId]/opengraph-image.tsx` | Explicit refusal; "Digital document"; the `ZINE` label. |
| `lib/inprocess.ts`, `lib/kv.ts` | `kismet_zine` on the metadata types. |
| `components/MomentDetailView.tsx` | The `isZine` branch; `kismet_zine` carried through metadata edits (the `kismet_bg` lesson). |
| `lib/media/modelFetch.ts` | `fetchMediaBlob(urls, { expect })` — the owned download generalized over a `MediaExpectation` (magic, MIME, label); `fetchModelBlob` is the GLB instance, byte-for-byte unchanged in behaviour (`verify:model-fetch` passes untouched). |
| `scripts/verify-zine-media.ts` | The oracle (63 checks, in `verify:flows`): one PDF definition, one cap, the gate with an injected parser, the fail-safe resolver shape, the hint reader, the download's magic check and copy. `verify-model-media`'s "a pdf is REJECTED" row is now "refused without a parser". |
| `scripts/e2e/zine.mjs`, `scripts/e2e/make-pdf.mjs` | The browser check (hand-built fixture PDFs; mint preview pixels, lazy pdf.js, the reader on desktop and phone, spreads, zoom, deep link, gestures, the feed badge) — see `scripts/e2e/README.md`. |

**Verified on a clean build (2026-10-14):** `tsc --noEmit`, `eslint .`,
`verify:zine-media`, `verify:model-media`, `verify:model-fetch`,
`verify:collector-file`, `verify:a11y`, `next build`, `check:bundle` (no
route grew past the 10 % guard; no baseline bump), and `scripts/e2e/zine.mjs`
against the built app in headless Chromium.

## 21. Phase 2 — collectors-only zines, the phone, and Arjan's file (2026-10-15)

Round 3 asked for three things: show Arjan's actual PDF going through the
real build, validate the Phase 2 (collectors-only) design against the code
and implement it, and work out what the reader needs on an iPhone and inside
the Farcaster / Base Mini App. All three are done. The timings below come
from the built app in headless Chromium with software rendering — a phone's
JPEG decoder is faster than this sandbox and its JavaScript slower, so read
them as an ordering, not as absolutes.

### 21.1 Arjan's file through the real build

**The file.** `trpplzin0_forPrinting.pdf`: 2.4 MB, PDF 1.3, six A4 pages
(595 × 842 pt), each one baseline JPEG of 2480 × 3507 px (300 dpi, 8.7 MP),
no `/Rotate`, not linearized, an unembedded Helvetica reference; the pages
are the scans. It is a scanner's output wrapped for a print shop, and that is
the finding: the "forPrinting" export is IMPOSED. Each PDF page is a print
sheet carrying two zine pages side by side, turned 90°, in imposition order
(the sheet that folds into the middle, not the page that reads next). A
viewer cannot undo imposition; what it can do is turn the sheet upright, so
Phase 2 adds a rotate control (§21.3, row 9) and Arjan will export a
reading-order version for the mint. Every zine artist who only has a print
file will hit this; the mint preview shows it before anything is uploaded.

**What the viewer does with it.** `scripts/e2e/zine-showcase.mjs` drives the
build with the real file and photographs it (`.e2e/arjan/shots/`, gitignored):
the mint preview on page 1 and page 2, the optimized preview, the artwork
page, the reader on the cover and on the 2–3 spread, the feed card, and the
phone at DPR 3 — the cover, page 2, a double-tap zoom, and page 2 after the
turns that make this file readable. The measurements are in §21.4.

**What the measurements taught, including one wrong first reading.** The
first showcase run put the next page on a phone at about 0.8 s, and the first
draft of this section blamed the JPEG decode of an 8.7 MP scan. A trace of the
worker traffic (`GetPage` → `toBlob`) said otherwise: in this Chromium the
decode and draw of a 2480 × 3507 scan takes ~150 ms and the optimized 2000 px
page ~40 ms; the next page was already rendered ~170 ms after the first; the
0.8 s was the reader — a tap on the page edge waited out the 300 ms double-tap
window before turning, and the measurement sat on top of that — plus the
measurement itself. Three things followed, all shipped:

1. **Edge taps turn at once** (§21.3, row 15). The double-tap window now
   applies only to centre taps, where the chrome toggle and the zoom would
   otherwise fight. A key turn was 16 ms; an edge tap is now the same.
2. **The prerender window is one page either side on narrow viewports**
   (≤ 700 px CSS; two on wide ones), kept for the reason that survives the
   correction: Safari has no `ImageDecoder`, so pdf.js decodes JPEG in
   JavaScript inside its worker, where an 8.7 MP page is several times the
   work of a 2.8 MP one; two each way after every turn is heat, battery and
   memory for pages the reader may never reach, and one ahead is ready before
   anyone turns.
3. **"Optimize for phones"** — an opt-in pass on the mint preview (§21.3,
   row 8) that re-renders every page at 2000 px on the long edge and writes an
   image-only PDF: 2.3 MB → 1.3 MB on the wire for this file, and a third of
   the pixels per page for Safari's decoder. The sandbox cannot measure that
   Safari gain; the first real iPhone session should (§21.6).

### 21.2 Collectors-only — validated against the collector-file code, then shipped

§8.2 and §10 said: a collectors-only zine is an image moment (the cover on
Arweave) with the PDF in the private collector-file store. Validating that
against the store before writing a line found no contradiction and three
things worth being precise about:

- **The store already had everything but "view a PDF".** The record
  (`kismetart:cfile:<ref>`, a `CfileRecord` with a versioned `current` and
  `history`), the chunked blob, the attach / replace / rollback / detach
  planning (`lib/collectorFileCore`), the gated byte routes
  (`/api/collector-file/view` for in-browser viewing, the ticket-first
  `/download`), the quotas, the audience notifications and the admin
  kill-switch are untouched. The one storage-layer change: `pdf` joined
  `CFILE_VIEWABLE_KINDS` (`glb`, `pdf`, `svg`), so a holder's `read` is the
  same same-origin gated fetch the GLB viewer makes, and the bytes go from
  that response straight into `openPdf` — never through a navigable URL
  (the response is `attachment`, and `private, max-age=3600` as the view
  route's standing policy for every viewable kind).
- **The page count lives on the version row** (`CfileVersion.pages`, `pages?`
  on the public descriptor). It is display metadata: counted client-side at
  attach (`sniffPdfFile` → `inspectPdfFile`), sent as `?pages=` (1..420, else
  ignored), stored only for `kind === 'pdf'`, and carried through replace and
  rollback exactly as `kind` is — `verify:collector-file` pins that. It is
  never a control; the reader counts pages from the document it opens.
- **Attach is awaited at mint, with one retry.** The moment mints as an image
  moment (the rendered or uploaded cover, `kismet_zine: { pages, access:
  'collectors' }`, no `animation_url`); the form then attaches the PDF as the
  collector file under one toast ("Minted — attaching the zine for
  collectors…") and retries once before telling the artist to attach it from
  the artwork page. The mint never blocks on the attach, and the artist is
  never left believing the zine is readable when it is not. A cached upload
  from an earlier attempt is discarded when the access mode flipped, because
  the two modes upload different files (the PDF vs. the cover).

What the artist sees: a "Who can read it" control (everyone / collectors
only; everyone is the default, per round 3) with one line of consequence each
("the PDF is stored on Arweave — public and permanent" / "stored privately on
Kismet; only the cover is public…"); in collectors-only mode the collector-file
slot reads "the zine is the collector file · N pages — only collectors can
read it" and hides its own upload. What a reader sees: the badge says
"zine, N pages, collectors only" (from the hint — the metadata carries no
PDF); the artwork page shows the cover and no reader; the collector card says
"collector download · issue-1.pdf · 2.3 MB · 6 pages · v1" with `read` for
holders and "collect to read" for everyone else; a holder's `read` opens the
same reader (history-backed close, resume, rotation, haptics) over the private
bytes, behind a progress shell ("opening zine… 1.2 MB of 2.3 MB") while they
arrive.

Verified: `verify:zine-media` (the collectors builder: image + hint, no
`animation_url` / `content`), `verify:collector-file` (viewable kinds; `pages`
through attach, replace and rollback), the e2e's mint-form access control (the
radio flips what is uploaded) and its C3 section — the record is seeded into
the Redis stub so the SERVER-RENDERED page carries the descriptor exactly as
production does; a non-holder sees the card, the count and "collect to read",
gets no `read`, loads nothing from pdf.js, and costs zero status requests. Not
verified in a browser: the holder's `read` (it needs a holder session the
sandbox cannot mint); the view route's gate is unchanged and oracle-covered,
and the viewer's PDF branch is the Phase 1 reader over a `Uint8Array`.

### 21.3 iPhone and Mini App — what was researched, what was decided

The reader is a full-screen layer inside a webview that may be Safari, the
Farcaster client's WKWebView, or the Base app's React Native webview. Each row
is a concern, what is true of those hosts, and where the decision lives.

| # | Concern | What is true | Decision (where) |
|---|---|---|---|
| 1 | **The back gesture** — iOS's edge swipe and a host's back button pop history | A reader that is React state alone is torn out from under the user by a back gesture: they lose the artwork page, not the reader | Opening pushes one history entry; popping it closes the reader; the X and Escape pop that entry themselves, so no dead reader entry is ever left behind (`lib/zineHistory.ts` `useReaderHistory`; e2e: "browser back closes the reader", "closing leaves no reader entry behind") |
| 2 | **Horizontal swipes in a Mini App** — hosts own edge swipes for dismiss and navigation | `sdk.actions.ready({ disableNativeGestures: true })` is already how the app announces itself (`providers/FarcasterProvider.tsx`), so page swipes reach the reader | Nothing new to build; recorded so nobody removes that flag without knowing the reader depends on it |
| 3 | **"Download PDF" in a Mini App** | A `target="_blank"` anchor goes nowhere in the RN webview | In a Mini App the button calls `sdk.actions.openUrl(gatewayUrl)` (the collector-file download's route); on the web it stays an `<a download>` to the gateway, never through our proxy (`components/MomentZine.tsx`) |
| 4 | **Haptics** | Farcaster hosts expose `sdk.haptics`; Safari has no vibration API | `selectionChanged` on each page turn, Mini App only, through the existing capability-gated helper (`lib/farcasterHaptics.ts` `hapticSelection`); nothing on the web |
| 5 | **Long-press on a page** | iOS raises the image callout (save / copy) on any `<img>` | `-webkit-touch-callout: none` on page images — the Download button is the sanctioned path; a nudge, not DRM (a public zine is public) |
| 6 | **Rubber-banding, pull-to-refresh** | A swipe that overshoots scrolls the page behind the layer or refreshes it | `overscroll-behavior: none` on the reader root; body scroll locked while open, the previous overflow restored on close |
| 7 | **Memory** — WebKit's per-page canvas budget and lazy canvas reclaim | The documented limits (§6.1): ~16.7 MP per canvas, a budget across live canvases, memory not returned until a canvas is zeroed | Unchanged from Phase 1 and now load-bearing: every render becomes a JPEG blob and its canvas is zeroed; 16 MP / 4096 px caps; blobs outside the window are revoked; the window is one page either side on narrow viewports (`ZineReader.tsx` `WINDOW_NARROW`) |
| 8 | **Decode cost** — 300 dpi scans are 8–9 MP per page | ~150 ms per page here, with Chromium's native decoder (§21.4); Safari has no `ImageDecoder`, so pdf.js decodes JPEG in JavaScript and the page's pixel count is the cost | "Optimize for phones" at mint (`lib/media/optimizePdf.ts`, `components/OptimizeBar.tsx`): each page re-rendered at 2000 px long edge, JPEG 0.85, written into an image-only PDF by `writeImagePdf` (one DCT XObject per page, the page's own aspect as its MediaBox, the title, a real xref — checked byte by byte in `verify:zine-media` §7). Opt-in, with undo; refused as "Already compact" when it saves under 15 %. The button's tooltip and the result toast state the one real trade: pages become images, so text stops being selectable — right for a scan, a choice for a born-digital zine |
| 9 | **Landscape and imposed pages** (§21.1) | A sideways sheet on a portrait phone is unreadable at fit-to-width | A rotate control (and `r`; `R` turns the other way, for the sheet that lands upside down after the first turn — Arjan's does): quarter turns, remembered per artwork (`kismet:zine-rotate:<key>`), the zoom reset, renders in flight discarded so a turn never shows a stale orientation (e2e: "rotating turns the page a quarter turn", "keeps the place", "three more quarter turns are upright again") |
| 10 | **Safe areas** — the notch and the home indicator | Only pages with `viewport-fit=cover` draw under them; this app sets none | Nothing to do; the chrome never sits under the indicator |
| 11 | **Fullscreen** | iPhone Safari has no element fullscreen API | The button appears only when `document.fullscreenEnabled` is true; the reader is already a full-viewport layer, so an iPhone loses nothing |
| 12 | **Chrome auto-hide** | On touch every swipe moves the pointer; revealing on pointer move would flash the chrome on every page turn | Reveal on pointer move for non-touch pointers only; on touch a centre tap toggles it (e2e: the phone section) |
| 13 | **Escape and focus** | The scrubber and a zoomed page can hold focus | Escape is captured at the window, so the dialog closes from anywhere inside it; the focus trap and live announcements are Phase 1 |
| 14 | **Opening twice** — the mint gate then the preview, or a reader closed and reopened | pdf.js destroys a worker it created with the document; a worker handed in stays ours (`pdfjs-dist@6.4.299` `getDocument` sets `task._worker` only when no worker was supplied) | One `PDFWorker` per page session for every document; a worker that fails is replaced, never reused (`lib/pdfjs.ts`); the mint pick → preview time halved with it (§21.4); e2e: a reopen after a history close resumes on the last page without a second worker fetch |
| 15 | **Tap latency** | An edge tap that waits out a 300 ms double-tap window before turning reads as lag on every page (measured, §21.1) | Edge taps turn at once; the double-tap window applies to centre taps only, where the chrome toggle and the zoom would fight (`ZineReader.tsx` `endPointer`) |

Considered and not done, with the reason: a service worker to cache the PDF
(the app has none; Arweave bytes are immutable and the browser cache already
keeps them); range requests / progressive loading (v2 per §6.3 — Arjan's file
is not linearized, and the gateway's `Accept-Ranges` cannot be verified from
here); WebP page blobs (no measurable gain on photographic scans, and JPEG is
universal); keeping canvases instead of blobs (row 7); the native viewer
(`<iframe>` / `<object>`) on iOS (a scrolling preview with no page turn,
inconsistent inside the Mini App webviews — rejected in §4.3 and confirmed
here).

### 21.4 Measurements

Headless Chromium (software rendering) against the built app on
`localhost`, the PDF served from memory, so the network is not in these
numbers; a phone's JavaScript is slower and (in Safari) so is its JPEG
decode, see §21.1. `scripts/e2e/zine-showcase.mjs` with Arjan's file.

| Step | Phase 1 build (10-14) | Phase 2 build (10-15) |
|---|---|---|
| Mint: PDF picked → page 1 preview on screen | 2.56 s | 1.10 s (one worker shared by the gate and the preview) |
| Mint: "optimize for phones", 6 pages | — | 1.41 s; 2.3 MB → 1.3 MB |
| Desktop (1280 px, 2× DPR): tap → page 1 (download + parse + render) | 0.96 s | 0.99 s |
| Desktop: → the 2–3 spread | 35 ms | 32 ms |
| Phone (390 px, 3× DPR): tap → page 1 | 0.95 s | 0.98 s |
| Phone: edge tap → page 2 | 0.81 s (the 300 ms tap wait; the tap came 0.3 s after page 1, before its prerender had landed) | 28 ms, after a 1.5 s dwell |
| Phone, the optimized file: tap → page 1 | — | 1.12 s |
| Phone, the optimized file: edge tap → page 2 | — | 25 ms |
| One page, decode + draw (worker trace, `GetOperatorList` → `toBlob`) | — | ~150 ms at 2480 × 3507; ~40 ms at 2000 px |
| Key turn → next page | — | 16 ms |

Where the ~1 s to the first page goes (the trace): ~0.2 s for the reader
chunk and the bytes, ~0.3 s for the worker to parse the whole file, ~0.2 s
to render page 1, ~0.15 s for the blob to decode and paint as an image. The
parse is proportional to the file, which is the case for the optimizer today
and for progressive loading in v2.

### 21.5 Verification (2026-10-15)

- `npm run check` on the final build: `tsc --noEmit`, `eslint .`,
  `check:resource-hints`, `check:bundle` (no route grew past the 10 % guard;
  the `/play/*` routes it lists as new to the baseline are not this work and
  were left for their owner), every `verify:*` suite — `verify:zine-media`
  and `verify:collector-file` with their Phase 2 rows, `verify:model-media`,
  `verify:model-fetch`, `verify:a11y` among them — and the agent routes
  end-to-end (203 checks).
- `next build`; the one warning is a dependency's own (`ox`), present before
  this work.
- `scripts/e2e/zine.mjs` against the built app with the Redis stub: 75
  checks, all passing — sections A/B (the mint form, the access control, the
  optimizer), C (the reader: spreads, keys, scrubber, zoom, rotation, Escape,
  the history close, the resume on reopen, worker reuse), C3 (the
  collectors-only card as a non-holder, record seeded), D (the phone: swipe,
  tap zones, chrome), E (the feed: badges, covers, no pdf.js).
- `scripts/e2e/zine-showcase.mjs` with Arjan's file: the screenshots in
  §21.1 and the timings in §21.4, on the same build.
- Two scratch traces (not committed) of pdf.js worker traffic: the reopen
  after a history close, and the phone page turn — the second found the tap
  wait and the real decode figures (§21.1).

### 21.6 Still open

- **The Discover button** — deferred by decision (round 3) until the rest was
  complete; §11.5 still says where it goes.
- **Arjan's reading-order export** — the minted file should be the
  reading-order one; the print file reads sideways in sheet order even with
  rotation.
- **The holder's `read` in a browser** — needs a holder session; the server
  half is oracle-covered and the client half is the Phase 1 reader. The first
  real collectors-only mint should be opened by a holder on an iPhone before
  it is announced.
- **Progressive loading (v2)** — the "download the whole zine first" cost is
  now a mint-time choice (optimize) rather than a reader-time one; range-based
  loading remains the way to make a 40 MB zine open fast and should arrive
  together with a linearize step.

Files for Phase 2:

| File | Role |
|---|---|
| `lib/collectorFileTypes.ts`, `lib/collectorFileCore.ts`, `lib/collectorFile.ts`, `app/api/collector-file/route.ts` | `pdf` is viewable; `pages` on the version row, in the public descriptor and on the attach route (`?pages=`, 1..420). |
| `lib/media/zineMedia.ts` | `zineMomentFields` takes a public (PDF + cover) or a collectors (cover only) input; the access copy. |
| `components/MintForm.tsx`, `components/OptimizeBar.tsx`, `lib/media/optimizePdf.ts` | The access control, the awaited attach with its retry, the optimizer and its bar. |
| `components/CollectorFileCard.tsx`, `components/CollectorFileViewer.tsx`, `components/CollectorFileManagePanel.tsx` | `read` / "collect to read" and the page count; the viewer's PDF branch; the page count at attach. |
| `components/ZineReader.tsx`, `components/MomentZine.tsx`, `lib/zineHistory.ts`, `lib/farcasterHaptics.ts`, `lib/pdfjs.ts` | Rotation, the narrow prerender window, the history-backed close, the Mini App download and haptics, the touch callout and overscroll rules, the shared worker. |
| `components/ZineBadge.tsx`, `components/MomentCard.tsx`, `components/FeaturedMoment.tsx` | The badge from the hint, with "collectors only". |
| `scripts/verify-zine-media.ts`, `scripts/verify-collector-file.ts`, `scripts/e2e/zine.mjs`, `scripts/e2e/zine-showcase.mjs`, `scripts/e2e/redis-stub.mjs` | The oracles; the e2e's Phase 2 sections; the showcase; the stub's seeded record. |

## 22. Audit (2026-10-15) — the whole implementation, end to end

**Method.** The branch's full diff against its base (`096a705`, 48 files);
three independent reviews, each briefed with files and a goal and none of
my conclusions — the reader stack, the mint form with the optimizer, the
collector-file store with every surface; every verify suite; both browser
suites (the zine's and the 3D one, which exercises the mint form and the
owned download the two features share); a build of the base commit beside
the branch build for the bundle delta per route; and a walk through the
artist's and the collector's journeys looking for what neither test nor
reviewer measures. Every finding below was verified against the code before
it was acted on; the reviewers' claims that did not hold (the reader "never
takes focus" — the focus trap does) were dropped.

### 22.1 Fixed — would have shipped wrong

| # | What | Where | The fix |
|---|---|---|---|
| 1 | "Optimize for phones" (and its undo) lost "collectors only", the uploaded cover and the page chosen as the cover: the optimized file goes through the same async pick gate as a drop, whose completion resets a new pick's choices — a timer fired before the gate had parsed the PDF. A collectors-only zine would have minted public. | `MintForm` | The choices that belong to the zine ride a carry keyed on the file about to be installed; the `[file]` effect restores them when that file lands. Pinned by e2e A2 on a fixture the optimizer can shrink. |
| 2 | A collectors-only zine resumed after a failed attempt uploaded its cover a second time, as a poster (the banked media IS the cover). | `MintForm` | The poster fallback applies only when the banked media needs one (a PDF, a model). |
| 3 | A cover changed after a failed attempt (another upload, another page) was ignored on resume: the bank was keyed on the PDF alone. | `MintForm` | The bank carries the cover's identity; a different one is a miss (a reload's record, which keeps no File, counts as unknown, not different). |
| 4 | Page flips never cancelled queued renders: a scrubber drag across a 400-page zine queued every page it passed, each rendered to completion. | `ZineReader` | Queued jobs are cancelled when the window no longer wants their page, and a job that starts for a page the reader has left does nothing. |
| 5 | The first render on a landscape viewport was sized from a guessed aspect (the default, or page 1's) and stayed soft until the next turn. | `ZineReader` | The width is taken after the page's aspect is known; a learned aspect re-runs the window. |
| 6 | ctrl/⌘ + wheel (a trackpad pinch) zoomed the reader AND the page behind it — React registers wheel passively, where `preventDefault` is a no-op. | `ZineReader` | A native, non-passive wheel listener. |
| 7 | A failed open left a dead history entry, one more per retry: the entry was popped when the phase turned to error. | `MomentZine` | The error state lives inside the entry. |
| 8 | A reader entry left by an earlier open (reachable through the browser's forward button) made the close need two presses. | `lib/zineHistory` | One token per open; only this open's entry counts. |
| 9 | A public zine and a PDF attached as its collector file shared one resume key — and the `?page=` link opened the collector file at that page. | `CollectorFileViewer` | Its own key; no URL pickup. |
| 10 | The manage panel could PUT the previous pick's page count (a large PDF counted after a smaller one was picked), or none when saved mid-count. | `CollectorFileManagePanel` | A pick sequence; save waits for the count. |
| 11 | A stale collectors hint: re-pointing the media at a model badged the card twice; a detached or replaced collector file kept the "zine" badge. | `MomentDetailView`, `MomentCard`, `FeaturedMoment` | The edit flow keeps the hint only while the media is a still and the collector file (when the page knows it) is a PDF; cards never badge a zine over a model's or a video's badge. A detached zine keeps its badge until the artist's next metadata edit — §22.5. |
| 12 | The page-change callback and the haptic ran inside a state updater — twice under StrictMode. | `ZineReader` | Moved out, compared against a ref. |
| 13 | A phantom turn at the end of an odd spread (page 5 of 5 shown on 4–5: next slid, ticked and wrote `?page=5` with no visual change). | `ZineReader` | No turn past the last page; the button disables on the spread's right page. |
| 14 | A pinch that dropped to one finger panned from the lifted finger's start; a cancelled pointer (the browser took the gesture) acted as a tap. | `ZineReader` | The remaining finger re-bases the gesture; cancel clears state only. |
| 15 | Any open failure but a malformed file destroyed the shared worker — with other documents on it (the mint preview while the gate inspects a second pick). | `lib/pdfjs` | Reset only when the worker is dead or the error names it. |
| 16 | A render whose signal was aborted during the preceding `getPage` ran to completion and was discarded. | `lib/pdfjs` | `throwIfAborted` at entry. |
| 17 | The crisper zoom render for a page the reader had left was installed anyway and shown at fit size on return. | `ZineReader` | Dropped unless page and zoom still match. |
| 18 | A non-ASCII zine title ("Café №1", a Japanese title) was stripped from the optimized PDF's Info dictionary. | `lib/media/optimizePdf` | UTF-16BE hex strings; an oracle row. |
| 19 | A PDF dropped into any cover slot, or as a machine frame, was told where zines are minted instead of what the slot takes. | `lib/media/mintMedia`, `lib/experience/frameUpload` | The slot's own copy. |

### 22.2 Left to be desired, now provided

| # | For | What | Where |
|---|---|---|---|
| 20 | the artist | They could not read their own collectors-only zine: the view gate admitted holders only, and the artist typically holds no edition. | `/api/collector-file/view` admits the artwork's managers (the predicate the attach/replace routes use), view only — no ticket, no download, no downloader stat; the manage panel gets `read` / `view` for viewable kinds and shows the zine's page count. The view route's comment, which still said "glb/svg", now says what it serves. |
| 21 | the collector | The card said "collector download" of a zine, "your download is ready" after collecting one, and a password-protected PDF failed with "could not start in this browser". | "collectors-only zine ·", "your zine is ready — read it", "This PDF is password-protected — download it and open it with the password"; the artist attaching one is warned that collectors will download, not read. |
| 22 | keyboard and screen-reader users | Hidden chrome stayed in the Tab order (invisible buttons took focus); on close, focus went to the document top because the read button had unmounted. | Focus landing on a hidden bar reveals it; the read button that returns on close takes focus. |
| 23 | the artist | The optimize pass could not be cancelled (420 pages for a file nobody will mint), showed "page 0 / N" first, and read every page to a screen reader. | Aborted by a new pick or by leaving the form; an "opening" step; the live region announces the phase, the page counter is visual. |
| 24 | the artist | The attach-after-mint retry was back-to-back; the route's transient answers are 503s that a second request a millisecond later meets again. | A 2.5 s pause before the one retry. |
| 25 | the codebase | The zine's metadata fields were assembled inline in the form; the "one definition" (`zineMomentFields`) was called by the oracle alone. | The form calls it; the oracle now pins what ships. |

### 22.3 Bloat removed

- `ModelOptimizeBar` and `ZineOptimizeBar` were the same component with a
  different busy label: one `OptimizeBar` (`components/OptimizeBar.tsx`),
  the callers word the step and the button.
- Dead: `clearPageParam`, `hasPdfExt`, `PageRender.aspect` and
  `RenderedPage.aspect`, the optimizer's `longEdge` / `quality` options; four
  constants exported from `lib/pdfjs.ts` and one from `optimizePdf.ts` that
  nothing imported are module-private; the hint's shape is declared once
  (`ZineHint`) instead of three times; the resolver reads the hint through
  `readZineHint` (which now also bounds `pages` by the cap, so a hand-written
  token cannot badge "99999999 pages"); the attach route's 415 copy derives
  from `CFILE_KIND_LABEL`.
- `CollectorFileViewer` (the GLB / SVG / PDF viewer and the PDF engine's
  loader behind it) is loaded on the click that opens it, not with the
  artwork route.
- Bundle, measured against a build of the base commit with the same
  `node_modules` (uncompressed JS per route, `.next/app-build-manifest.json`):

  | Route | Base | Branch | Delta |
  |---|---|---|---|
  | `/mint` | 1340 KB | 1357 KB | +16.6 KB (1.24 %) |
  | `/artwork/[address]/[tokenId]` and its modal twin | 1311 KB | 1324 KB | +12.7 KB (0.97 %) |
  | `/` | 1276 KB | 1282 KB | +6.0 KB |
  | `/profile/[address]` | 1323 KB | 1328 KB | +5.7 KB |
  | `/collection/[address]` | 1285 KB | 1291 KB | +5.4 KB |
  | `/play/create-*` (a shared chunk) | 1182 KB | 1185 KB | +3.7 KB |
  | every other route | | | ≤ 1.3 KB |


  Everything the mint route gained is on its critical path by design (the
  pick gate, the preview, the access control); the artwork route's gain is
  the zine entry (`MomentZine`) and the badge; the reader, the optimizer and
  pdf.js itself load on a tap or a pick. No route grew past the 10 % guard
  (`check:bundle`), no baseline bump.

### 22.4 Regressions

- The 3D browser suite (88 checks) found one: its assertion on the mint
  gate's rejection copy expected the old wording ("… or a .glb 3D model");
  the branch's copy also names PDF zines. The assertion follows the product
  copy. Everything else in it — the posed preview, capture, optimize for
  web, the owned download, the viewer — passes on the branch.
- `verify:model-media`, `verify:model-fetch`, `verify:collector-file` and
  the rest of `verify:flows` pass; `checkMintMedia`'s order (typed image /
  video → GLB → PDF → extension fallback) adds one 5-byte sniff for typeless
  files and nothing for typed ones; the collector-file kinds and their
  magic are unchanged; `/api/img`, the OG route and structured data were
  read for a path to a collectors-only PDF and have none.
- Two behaviour changes are deliberate, not regressions: a 3D model whose
  poster upload fails now refuses to mint without an `image` (§17.2, the
  resume re-uploads only the poster); every pre-existing `pdf` collector
  file now offers `read` as well as `download`.

### 22.5 Verification

On the final build (2026-10-15):

- `next build` (the one warning is a dependency's own, `ox`); `npm run check`
  — typecheck, lint, resource hints, the bundle guard (no route past 10 %,
  no baseline bump), every verify suite including the writer's new rows
  (`/Length`, `/Size`, 20-byte xref entries, the UTF-16 title) and the agent
  routes end-to-end (203).
- `scripts/e2e/zine.mjs`: 81 checks, all passing — the 75 before, plus A2
  (a heavy scan is optimized; "collectors only" and the chosen cover page
  survive the optimized re-pick and its undo).
- `scripts/e2e/model-media.mjs`: 88 checks, all passing.
- The base-commit build comparison in §22.3.
- What the audit's own first run caught: when the render queue changed, the
  window effect lost the dependency it had on the rotation through `fitBox`,
  and page 5 never re-rendered after a turn; the e2e's rotation check failed
  on the first pipeline and the dependency is explicit now. The fixture the
  optimizer can shrink exposed nothing further.


### 22.6 Still open

- A detached or replaced collectors-only zine keeps its "zine" badge until
  the artist's next metadata edit (the badge is token metadata; a detach is a
  Kismet-side action with no on-chain write). The edit flow drops it then.
- The Discover button (deferred by decision), Arjan's reading-order export,
  the holder's `read` in a browser, and Safari's JavaScript JPEG decode as
  the measurement that decides how much the optimizer buys on an iPhone
  (§21.6).

## 23. Validation (2026-10-15) — every finding, its decision, its proof

The audit's findings were fixed on inspection first; this pass re-verified
each one with a test that targets the behaviour, and took a second look at
whether each fix was the right one for the design (§3–§10) rather than a
patch. "e2e" is `scripts/e2e/zine.mjs` (section named), "oracle" is
`verify:zine-media`, "gate" is the new `verify:cfile-view` (the collector
file's view route against the built app with Redis and the chain mocked),
"3D" is `scripts/e2e/model-media.mjs`.

### 23.1 The reader

| Finding | Decision | Proof |
|---|---|---|
| Flips never cancelled queued renders | Fixed: the window cancels what it no longer wants; a job for a page the reader left does nothing | e2e C1: a scrubber drag across a 60-page zine whose every page is slow starts ≤ 12 renders (counted at the worker), and page 60 is on screen within seconds |
| First render sized from a guessed aspect | Fixed: the width is taken after the aspect is known; a learned aspect re-runs the window | e2e C1: a landscape page in a spread is rendered at ≥ 95 % of its slot × DPR |
| The regression the first fix caused (rotation no longer re-queued) | Fixed: the window depends on the rotation explicitly | e2e C: rotate → page 5 re-renders; three more turns upright |
| ctrl/⌘ + wheel also zoomed the page behind | Fixed: native, non-passive listener | e2e C: a ctrl + wheel zooms the page and `defaultPrevented` is true on the window |
| Side effects in a state updater | Fixed: compared against a ref, run once | By construction (the updater is now pure); the e2e's page-change and resume checks still hold |
| Phantom turn past an odd spread | Fixed: no turn past the last page; the button disables on the spread's right page | e2e C2: a 5-page zine on 4–5: ArrowRight turns nothing, the URL is unchanged, Next is disabled |
| Pinch → one finger; pointer cancel | Fixed: re-based on the remaining finger; cancel clears state | Inspection: Playwright has no multi-touch; the re-base reads the current pan from a ref and the cancel path clears the pointer map, the gesture and the tap timer |
| Zoom render installed for a page the user left | Fixed: dropped unless page and zoom still match | Inspection, plus the existing double-tap / reset checks |
| Hidden chrome in the Tab order | Fixed: focus on a bar reveals it | e2e C: the chrome hides on a desktop, Tab reveals it |
| Focus into the dialog, back to the opener | Confirmed (the trap focuses the first control) and fixed (the read button takes focus on close) | e2e C: `activeElement` is inside the dialog after the tap, on the read button after Escape |
| A failed open leaves a dead entry per retry | Fixed: the error state lives inside the entry | e2e C3: the zine URL answers 500; a retry adds no entry; back from the error restores the affordance on the same URL |
| A stale marker makes close need two presses | Fixed: per-open tokens | e2e C: forward onto an old reader entry does not reopen; a reader opened over it closes with one Escape |
| Worker reset on any open error | Fixed: only when the worker is dead or the error names it | Inspection (the mint gate inspects a second pick while the preview holds a document; `verify:zine-media`'s gate rows cover the error kinds) |
| Already-aborted render ran to completion | Fixed: `throwIfAborted` at entry | Covered by C1's render count |
| Dead code and export-only constants | Removed | `tsc`, `eslint`, the oracles |

### 23.2 The mint form and the optimizer

| Finding | Decision | Proof |
|---|---|---|
| Optimize / undo lost the zine's choices | Fixed: a carry keyed on the installed file | e2e A2: "collectors only" and the chosen cover page survive the optimized re-pick and its undo, on a 6 MB fixture the optimizer shrinks |
| A resumed collectors-only zine uploaded its cover twice | Fixed, and the decision made pure | oracle §8: a banked cover owes no poster; a banked PDF or model does |
| A cover changed after a failed attempt was ignored | Fixed, pure | oracle §8: a changed cover is a miss, an unknown one (a reload) a match, the access mismatch both ways, a different pick, a session given up on |
| The attach retry was immediate | Fixed: 2.5 s pause | Inspection (the route's transient answers are 503s; the pause is the only change) |
| Non-ASCII titles stripped | Fixed: UTF-16BE | oracle §7: "Café №1" survives as `<FEFF…>` |
| The form built the zine's fields inline | Fixed: `zineMomentFields` | oracle §4 pins the builder the form now calls; `tsc` ties the call to the type |
| The optimize pass could not be cancelled | Fixed: aborted by a new pick or leaving the form | e2e A2: clearing the pick mid-pass produces neither a result nor an error |
| "page 0 / N"; every page announced | Fixed: an opening step; the live region announces the phase only | Inspection (the busy shape is typed; the detail is `aria-hidden`) |
| A PDF in a cover slot told where zines are minted | Fixed | oracle: the cover gate's own copy for a PDF |
| The writer's `/Length`, `/Size`, xref entries | Pinned | oracle §7 rows |

### 23.3 The store and the surfaces

| Finding | Decision | Proof |
|---|---|---|
| The artist could not read their own collectors-only zine | Fixed: managers may view, view only | gate: a manager holding no edition reads the bytes (200, the same sha256, `attachment`, `private`); the ticket route still refuses them; a stranger is 403, no session 401; a failing permissions read keeps the 403 |
| The page count: stored, carried, bounded | Confirmed | gate: `?pages=3` rides the attach into the descriptor and the public status; `?pages=999` is not stored; oracle: `readZineHint` refuses a count past the cap |
| A public zine and a PDF collector file shared a resume key | Fixed: its own key, no `?page=` pickup | Inspection (`cfile:` prefix; `readStartPage(key, { url: false })`), the e2e's resume checks on the public zine unchanged |
| The manage panel's page-count race | Fixed: a pick sequence; save waits | Inspection (the handler is sequenced on a ref and the save button disables while counting) |
| A password-protected PDF told as "could not start" | Fixed: told as itself; the artist warned at attach | Inspection (the copy keys exist and are wired; a protected fixture would need a password-capable writer, which the repo deliberately lacks) |
| The stale collectors hint | Fixed: the edit flow keeps it only while the media is a still and the collector file (when known) is a PDF; cards never badge over a model | e2e E: a model moment carrying a collectors hint shows the model's badge and no zine badge |
| `collector download` on a zine; "your download is ready" | Fixed | e2e C3 (the card reads "collectors-only zine · … · 6 pages · v1") |
| A PDF as a machine frame | Fixed: the frame's copy | Inspection |
| The view route's stale comment; the doc's cache claim | Fixed | Read |

### 23.4 Regressions, bloat, and what the pass itself found

- The 3D suite's one stale assertion (the gate's copy) was the only
  regression; it follows the product copy now.
- The bundle, measured again against the base commit after the audit's
  own changes (the lazy viewer, the hint module, the merged bar): §22.3's
  table holds, and the mint route's +1.4 KB since the audit is the carry,
  the abort and the builder call.
- The validation pass found two of its own. The e2e's optimize section
  cleared the form twice (the second clear is conditional now). And a 3D
  check — the still fading after the model paints — failed twice in a row
  although nothing on the 3D path had changed: the in-process route
  harnesses (the agent routes' and the new gate script, which copied it)
  start the built app through `npx next start` and stopped it with a
  signal to the `npx` wrapper alone, so each run left a `next-server`
  orphaned and spinning at full CPU on the mocks that had gone with the
  harness. Three of them starved the browser's animation clock, and a CSS
  transition that never advances reads as a fade that never happens. Both
  harnesses now start the server in its own process group and stop the
  group; the 3D suite passes again once the orphans are gone.

### 23.5 What stays inspection-validated, and why

Multi-touch (pinch hand-off) and the manage panel's pick race need a
manager session and multi-touch input the browser harness does not have;
both fixes are small and read in full. The holder's `read` in a browser
remains the one path no harness here can drive end to end; its server half
is the gate script above and its client half is the same reader the public
zine uses.

## 24. Line review (2026-10-16) — every added line against measured coverage

The brief: every line about to be committed earns its keep with validated
evidence. So line coverage of the whole branch diff was measured and each
added line read against it — not "looks reached" but a count.

### 24.1 How coverage was measured
- **Browser.** Both end-to-end suites (`scripts/e2e/zine.mjs`,
  `scripts/e2e/model-media.mjs`) ran under a V8-coverage hook against a
  source-mapped production build; Playwright's per-page coverage was mapped
  back through `.next/static/chunks/*.js.map` to the TypeScript sources, taking
  the innermost covered range at each mapped position for a per-line count.
- **Node.** The verify oracles ran under `NODE_V8_COVERAGE` (type stripping
  keeps source positions, so the counts land on the real lines).
- The two were merged (max count per line) and intersected with the lines the
  branch ADDED (`git diff -U0` against the base `096a705`), counting only code
  lines — comments, braces and JSX punctuation excluded.

The build carried one temporary line for this — `productionBrowserSourceMaps`
behind an `E2E_COVERAGE` env guard — reverted before the commit; it changes
nothing the app ships, and the committed build emits no source maps.

### 24.2 The numbers
Of **2,079** added code lines, **1,542 (74%)** execute under a named e2e check
or oracle row. The rest is not untested by choice — it is every path no
harness in this repo can reach, in four groups:

| residue | lines | why no harness here reaches it |
|---|---|---|
| Server routes + holder/manager/owner-gated client (the API routes, `CollectorFileViewer`, `CollectorFileManagePanel`, the mint SUBMIT + attach path) | ~300 | no wallet connector or chain in the browser harness, and no mint. The server half — who may read/write and the exact bytes — is the `verify:cfile-view` and `verify:collector-file` oracles; the pure decisions (resume, the metadata builder) are `verify:zine-media`; the client half is the same pdf.js reader the public-zine e2e drives end to end |
| Home / collection / profile-owner components carrying the one-line still-and-badge guard (`FeaturedMoment`, `CustomizePanel`, `PatronArtworkShowcase`) | ~12 | those pages are not visited by the suites; the identical guard is e2e-proven on `MomentCard` (feed E) |
| Mini App + multi-touch + fullscreen runtime (`farcasterHaptics`, the reader's pinch / one-finger re-base / fullscreen / Mini App download button) | ~30 | `isInMiniApp` is false outside a Farcaster host; Playwright drives one pointer; headless fullscreen is unreliable |
| Defensive / edge paths the happy path makes unreachable (`ZinePreview`'s own open/render failure — the mint gate rejects an unreadable PDF first; the render-failure tile; `zineHistory`'s storage-throw and navigation-close branches; pdf.js's chunk-load and worker-death resets) | ~40 | each is a real production fallback, read in full; the gate or the browser makes it unreachable from a test |

Two lines read "uncovered" only as coverage artifacts and are proven by an
assertion: `zineMedia.asPdfFile`'s re-wrap line (the oracle asserts the
re-wrapped type) and `pdfjs.isPasswordException` (the new locked-PDF test
asserts the password toast, which only fires if it returns true).

### 24.3 What this pass changed
**Cut — did not earn its keep.**
- `zineHistory.readerEntryToken`: the `try/catch` around `window.history.state`
  (reading `.state` does not throw) — removed.
- `lib/media/zineMedia.ts`: a stale orphaned doc comment left by the audit.
- Comment references to the old `lib/media/zineMedia` home of the hint type
  corrected to `lib/media/zineHint` (`lib/kv`, `lib/inprocess`,
  `resolveMomentMedia`); `optimizePdf`'s WHY note rewritten to the measured
  figures (~150 ms a page in Chromium, several times that in Safari's JS JPEG
  decode) in place of the earlier wrong "~0.8 s".

**Pinned — an untestable inline decision became a pure helper.**
The edit flow's "does this edit keep the zine hint?" was a three-way inline
expression in `MomentDetailView` that no harness drove. It is now
`zineHint.zineHintAfterEdit`, a pure function, with seven oracle rows
(`verify:zine-media`) over every branch: a PDF binding keeps the hint; a
re-point to a video, a model or a plain still drops it; a collectors-only zine
keeps it while its media is a still and its collector file is a PDF or unknown,
and drops it once the file is detached or replaced by another kind.

**Tested — inspection-only paths given real evidence.**
- Real password-protected and malformed PDF fixtures (`make-pdf.mjs`) drive the
  mint gate end to end, so pdf.js's own `PasswordException → {kind:'password'}`
  and malformed `→ {kind:'unreadable'}` mapping is proven, not just the gate's
  reasons (the oracle already pinned those with a fake inspector).
- A zine over the 16 MiB soft warning: the warning fires, names the optimizer,
  and the zine is still accepted.
- The optional cover IMAGE upload — the headline cover feature, previously
  exercised only as page-as-cover.
- The reader's whole key map: ArrowUp / PageUp / Backspace / Space /
  Shift+Space turns, +/-/0 keyboard zoom, Shift+R reverse rotate, and a plain
  wheel flick (the non-ctrl half of the native wheel listener).

**Fixed — one real bug the keyboard test surfaced.**
`ZineReader.step()` read the current page from closed-over state, so a
page-turn key pressed within a frame of the previous turn ran a step that still
saw the old page and the turn was swallowed — invisible at human speed, caught
by the rapid-key test. It now reads `pageRef.current` (the ref `setPage` keeps
in step with the state), matching the file's own pattern, so a turn is never
stale. The same test also pinned a harness truth worth recording: with the
scrubber focused, the arrows drive the slider natively (which still turns the
page) and the reader's own key handler only runs when focus is off the input —
so the keyboard tests focus the dialog first.

### 24.4 Re-verification
On the clean build (no source maps): `npm run check` green — typecheck, lint,
the bundle guard, and every verify oracle, including `verify:zine-media`
(with the new edit-hint rows), `verify:collector-file`, `verify:agent:routes`
(203/0) and `verify:cfile-view` (18/0). The browser suites on the
(functionally identical) source-mapped build: `scripts/e2e/zine.mjs` 121/0 and
`scripts/e2e/model-media.mjs` 88/0. The bundle stays within the 10 % guard; the
diff is refactor-only (a pure helper, a ref read, comment corrections, test
code), so §22.3's route table holds. No `next-server` orphan left behind.

## 25. The reading experience, refined (2026-10-16) — research, then build

The brief: research the best possible experience for this reader and build the
smoothest, most beautiful one we can — better than the industry standard while
keeping the feature simple. Two research passes ran first (one on how the best
readers handle the reading loop, one on the web techniques and iOS limits that
decide what feels native); this section records what they found, what was
built, what was rejected and why, and the proof.

### 25.1 What the research found
- **The page follows the finger.** 1:1 tracking, a release judged on speed as
  well as distance, an interruptible settle, a rubber band at the ends (Apple,
  WWDC18 "Designing Fluid Interfaces"; Photos; Instagram; Issuu since 2017).
  Commit rules in shipping code: Android's ViewPager turns on ≥ 400 dp/s over
  ≥ 25 dp, else ≥ 60 % dragged; PhotoSwipe on ≥ 0.5 px/ms, else > 50 % unless
  heading back faster than 0.1 px/ms; Swiper on a ≤ 300 ms gesture, else ≥ 50 %.
- **Open from the thing you tapped; exits retrace entrances** (WWDC18;
  PhotoSwipe's opener: the thumbnail zooms open, 333 ms).
- **Chrome answers to reading, not a clock**: show the title on open, hide on
  the first turn, never re-show on every turn, never hide a control that holds
  focus (Apple HIG "Going full screen"; W3C WAI list on hidden controls).
- **Position stays visible when the chrome goes** (Instagram's segments,
  Kindle's corner readout).
- **Spreads pair like a booklet, and a page that is already an opening stands
  alone** (IIIF facing-pages: such pages "MUST be displayed by themselves";
  Komga pairs the same way). Issuu pairs regardless, and spreads uploaded
  pre-paired come out paired twice — a documented complaint.
- **Show the object**: no page-curl, no sound, no drawn spine across art that
  runs over the fold (Apple Books dropped its drawn spine for fixed-layout
  books; W3C list on flip effects; Hacker News on novelty decay).
- **Technique (2026)**: WebKit runs CSS `linear()` easing on the main thread
  (WebKit 281429, still open April 2026 per 312407) — a spring encoded that way
  would jank on every iPhone; a `cubic-bezier` stays on the compositor. Release
  velocity: least squares over the last 100 ms, zero if the finger was still
  40 ms before lifting (Flutter's tracker), coalesced pointer events included.
  View Transitions exist in Safari/WKWebView 18 but freeze input while they
  run and have flicker bugs (WebKit 300877); the manual expand (FLIP on the
  compositor) is PhotoSwipe's approach too. Blur filters over moving content
  cost every frame on iOS; a thumbhash's average colour costs nothing.

### 25.2 What was built
| Moment | Before | Now | Why |
|---|---|---|---|
| Tap "read" | the slot showed "opening zine…" over the cover; the reader appeared only after download + parse + render (~1 s, longer on a slow link) | the cover — the very bitmap that was tapped — leaves its place on the page and settles exactly where page 1 will be, full-screen, in the zine's own light, with a hairline progress bar; page 1 then sharpens out of it (`components/ZineOpening.tsx`) | §5.2/§5.7 promised "the cover on screen at t=0"; this is that, with the open retracing the tap |
| Turning | release a swipe → the page changed with a 6 % slide | the page follows the finger; neighbours are already painted beside it; a throw turns from 20 px, a slow drag past the middle turns, a drag past the middle that turns back doesn't; ends rubber-band; every turn (keys, taps, wheel, buttons) is the same slide; a jump (scrubber, Home/End) lands at rest | the research's commit rules, the iOS rubber band (c = 0.55) |
| The settle | 180 ms ease-out | a bezier shaped like a critically damped spring, opened at the finger's own release speed, interruptible mid-flight (a finger landing on a moving page catches it where it is) | `linear()` springs jank on WebKit; velocity matching removes the hitch at release |
| Closing | X / Escape / back | also pull the page down (touch) — the artwork shows through as the room fades; X and Escape ease out | Photos/PhotoSwipe's dismiss; exits retrace entrances |
| Spreads | an 8 px gap; any two pages paired | pages meet at the fold under one shadow; a landscape page (a spread exported as one page) stands alone across the stage and pairing restarts after it | IIIF/Komga pairing; one sheet casts one shadow |
| The room | flat near-black | near-black lit by the cover's average colour (from its thumbhash: no image, no filter) | identity per zine at zero GPU cost |
| Chrome | hid on a 2.5 s timer, re-shown by every key | shows on open, on a moving mouse and on a centre tap; hides on the first turn or after a moment at rest — never while a control has focus; focus rests on the dialog, not a hidden button | HIG; WAI on hidden focused controls |
| Where am I | the counter, when the chrome showed | one mark per page (a line beyond 24), lit to the page in view, whenever the chrome is away | Stories-style ambient position |
| Desktop | edge clicks turned, invisibly | a chevron appears at the edge the cursor is on | discoverability without clutter |
| Zoom | jumped | double-tap and keys animate (PhotoSwipe's curve); pinch and wheel track the hand | — |
| Reduced motion | the slide became a fade | also no expand, no scale, no zoom animation, no sliding fill; a pull-to-close fades where it is let go; drags still track (direct manipulation); slow-update displays (e-ink) count | Apple HIG, WCAG 2.3.3 |
| Screen readers | every page a scrubber drag passed was announced | the page a reader settles on is announced | — |
| Collectors-only | "opening zine…" text in a box | the same opening frame with the artwork's cover — fading in where page 1 will be, since its read button sits in the collector card, away from the cover — and the same reader | the collectible deserves the same first moment |

### 25.3 Rejected, with the reason
- **View Transitions API** for the open: freezes input while running, aspect
  quirks, Safari flicker bugs; the manual expand does the same on the
  compositor and works on iOS 17.
- **A CSS `linear()` spring**: main-thread on WebKit (see above).
- **A drawn gutter shade**: it would darken art that runs across the fold;
  the scan keeps its own fold.
- **Page-curl, sound**: novelty that decays; slow on phones; an accessibility
  problem.
- **A thumbnail overview grid**: valued for long books; zines are mostly short,
  the scrubber and the position marks cover them, and every thumbnail is a full
  JPEG decode (several times dearer in Safari). Kept for later, as spreads.
- **Transform-driven pinch** (no React render per move): the render per move
  is one element's style; worth doing if a device shows jank.

### 25.4 Found while building
- **The stage was a scroll container.** Neighbouring pages now wait off-stage
  on the track, and `overflow: hidden` still lets anything that scrolls an
  element into view move the whole track (the e2e driver did, mid-slide, and a
  double-click turned back a page). `overflow: clip` clips without scrolling;
  a guard resets any stray scroll where `clip` is unsupported.
- **Scrubbing started a render per spread.** Learning every page's shape up
  front made `getPage` instant, which removed a worker round trip that had
  been hiding a fast scrub from the render queue: 31 renders started across a
  60-page drag (the C1 budget is 12). Views now arriving within 90 ms of each
  other defer their renders until the reader settles — reading-pace turns are
  never delayed.
- **The first page goes first.** The background shape pass (wide screens
  only) started on a fixed 400 ms timer, a guess a slow tablet still
  rendering page 1 would overrun; it now starts once the first view has
  painted. Its cost is small — 0.1–0.2 ms a page of worker time in pdf.js
  (Node: 1.3 ms for Arjan's file, 9.5 ms for 60 pages, 40 ms at the 420-page
  cap) — so this is an ordering guarantee, not a measured speedup.
- **A timing that measured the harness.** The showcase printed desktop page 1
  at 1.33 s against the phone's 1.03 s; the desktop span held the screenshot
  taken mid-expand, and every runner-side figure held the runner's own
  polling. Timed in the page from the tap's own event, page 1 lands in
  0.8–0.9 s on both (25.5). The showcase now times the open in the page.
- **The expand could start on a skeleton.** The frame drew the cover through
  a fresh image component, which runs its delivery chain from the top
  (optimizer → proxy → gateways). When the slot's cover had arrived through
  a fallback — the optimizer refusing a heavy scan — the frame's copy
  started over at the optimizer and the expand played a blank, pale
  skeleton for that round trip (reproduced: a slowly refusing optimizer
  left the frame's cover unloaded 120 ms in; the showcase caught the same
  sheet on Arjan's cover). The frame now draws the slot image's own
  `currentSrc` — the bitmap that was tapped, already decoded. The e2e
  opening section runs with that refusing optimizer and asserts the cover is
  complete the moment the frame appears.
- **Two fades at the handoff dip to dark.** While the opening frame is up the
  first page paints at full opacity; the frame's own fade is the crossfade.
- **Stacked scroll locks.** Two layers each "restoring what they found" leave
  the page locked or unlocked depending on unmount order; the hold is now
  counted (`lib/bodyScroll.ts`).
- **A double close.** Two layers calling the history close in one tick would
  go back twice and leave the artwork page; the close now pops our entry once
  (`lib/zineHistory.ts`), the opening frame stops taking Escape once the
  reader is up, and the reader captures Escape itself.
- **A hint left lit under a drag.** A mouse that hovered an edge and then
  pressed to drag left that edge's chevron lit over the incoming spread —
  hover is ignored while a button is down, so nothing put it away (the
  showcase's mid-drag frame showed it). Taking hold of the page now puts the
  hint away; a plain click at the edge keeps it.
- **Motion that reduced motion missed.** The strict check (no translate or
  scale animation anywhere in the reader's layers) caught the opening frame's
  progress fill still sliding; a probe then found the same in a long zine's
  position line and in the pull-to-close release. All three now jump or fade.

Each of the last four was reproduced on the build before its fix — the
check or probe failing there — and passes on the build after it.

### 25.5 Measurements and verification
On the final build (no source maps; `next start` against the redis stub):

| Suite | Result |
|---|---|
| `npm run check` | green — typecheck, lint, the bundle guard (no route past its threshold), every verify oracle; agent routes 203/0, collector-file view gate 18/0 |
| `scripts/e2e/zine.mjs` | **165/0** (121 at §24). New: the opening (C0 — up at once, the tapped bitmap in it from the first frame even with the optimizer refusing the cover, settled where page 1 will sit, the download shown, the cover's light, no jump at the handoff, focus on the dialog, Escape mid-download and after, a late response opens nothing, the page scrollable again); the hand (C4 — rubber band at the cover, 1:1 tracking with the next spread painted beside it, snap-back, a slow turn, a flick from 45 px, a drag that heads back, the fold under one shadow, neighbours hidden from screen readers, the position marks, the edge hints and a drag putting them away, a key turn's slide); reduced motion (C5 — no expand, no slide, a long zine's line and a pull-to-close fade); a real two-finger pinch and pull-to-close through the DevTools protocol (D) |
| `scripts/e2e/model-media.mjs` | 88/0 |
| C1: a scrubber drag across 60 pages | 4–5 renders started (budget 12); page 60 on screen in ~0.7 s |

Arjan's file (`trpplzine #0`: 6 pages, a 2.4 MB scan), timed in the page
from the tap's own event, every open across the probe and the showcase runs:

| Moment | Desktop 1280×800 @2× | Phone 390×844 @3× |
|---|---|---|
| Tap → the cover full-screen (the opening frame) | 10–15 ms | 10–15 ms |
| Tap → page 1 (download + parse + render, under the frame) | 796–895 ms | 775–822 ms |
| Page 1 → the frame gone (the crossfade) | 266–300 ms | 255–262 ms |
| The optimized file (1.3 MB): tap → page 1 | — | 645–724 ms |
| A turn onto a prerendered view (runner-side, an upper bound) | 25–91 ms (a spread) | 15–29 ms |

So a reader sees the cover itself under their finger within a frame of the
tap, and the zine's first page sharpens out of it under a second later —
where the old reader showed a text label in the slot for that second. These
are this container's figures (Chromium, a local server); a phone's own CPU
and network add to them, and Safari's JavaScript JPEG decode remains the
open measurement (§21.6).

## 26. Pre-merge review (2026-10-16) — ten findings, the Docker image, the proof

The brief: before the merge, review the branch for anything missed. A code
review of `main...HEAD` (8 commits, 59 files; `main` has not moved since the
branch began, so there is nothing to merge in) returned ten findings,
unverified. Each was traced to a real path before anything changed; every one
a harness here can reach was reproduced on the build before its fix — the
new check FAILING there — and passes on the build after it.

### 26.1 The findings
| # | Finding | Verdict | Fix | Proof |
|---|---|---|---|---|
| 1 | The Docker image ships without `public/pdfjs/` | **Confirmed — every zine broken in production.** Coolify builds the Dockerfile; its builder stage carries only `node_modules` from the deps stage and re-ran only the ffmpeg copy; `public/pdfjs/` is gitignored, so a clean context has none. The copy script's comment said the build would "fail loudly"; nothing checked | the builder re-runs `copy-pdfjs-assets.mjs`; `.dockerignore` keeps a workstation copy out (pdf.js refuses a worker of another version); a new `prebuild` check, `scripts/check-public-assets.mjs`, fails the build when the worker or its assets are missing or of another version | a real `docker build` of the old and new Dockerfiles from a clean context: the old image's `/app/public` has no `pdfjs/` and serves the worker as **404**; the new one has it and serves **200**, 1.32 MB, version 6.4.299. The check fails on a missing set and on a stale worker, passes on a good one, and ran inside the image build |
| 2 | The manage panel's Save stays disabled after a PDF then a non-PDF pick | Confirmed: the non-PDF pick never touched `counting`, and the superseded count skipped its reset | every pick starts uncounted | owner-gated (no wallet in the harness, §24.2) — traced |
| 3 | Escape on the opening frame (and the non-PDF collector viewer) pops two history entries under the overlay route | Confirmed — the overlay route's own Escape calls `router.back()`; only the reader captured the key. The viewer half is the §17 bug, now gone | captured on window with `stopImmediatePropagation`, as the reader | E2 (new): before, Escape on the frame dropped the reader back on the feed (`/profile`); after, the artwork overlay stays, and again after the reader's own Escape |
| 4 | Every PDF collector file is called a zine | Partly: "read" for any PDF is §10's design, the wording is not — a print-res export beside a public zine (§11) read "collectors-only zine" | the zine wording follows the artwork's `kismet_zine` hint (access "collectors"); any PDF keeps its page count and "read" | C3 (new): before, the print-res PDF read as a zine; after, "collector download", "collect to download" |
| 5 | The collector-file reader writes `?page=` into the artwork's URL | Confirmed — `?page=` addresses the public zine, so an artwork with both would open the wrong document's page | `rememberPage(…, { url: false })` | holder-gated — traced |
| 6 | The scrubber floods `replaceState` | Confirmed — one call per page; WebKit throws past ~100 in 10 s (and the resume write sat behind it in the same `try`) | the resume is written at once, the URL once the reader settles (300 ms), and only onto a reader's own history entry | C1 (new): before, 59 URL writes for a 59-step scrub; after, one |
| 7 | Reader keys swallow browser shortcuts (⌘R rotated) | Confirmed | Ctrl/⌘/Alt combinations stay the browser's | C (new): before, Alt+R rotated the page; after, nothing moves |
| 8 | A failed page render is never retried | Confirmed while the page stays in the render window | failed renders are dropped on each move and retried — once per move, never a loop | C6 (new): one page encode made to fail; before, page 1's tile survived moving away and back; after, page 1 renders |
| 9 | With no cover, a failed open unmounts the error frame | Confirmed, and made worse by §25 (the frame, not a line of text, was lost; the history entry was left behind) | a zine never hands its slot back; closing the error returns to the read button | (new) before, the frame and the read button vanished; after, retry and the PDF stay, and Escape returns to the read button |
| 10 | The collector viewer's own streaming loop briefly holds two copies (64 MiB → ~128 MiB peak) | Valid, not a defect — the public path (chunks → Blob → ArrayBuffer) has the same peak under the same cap | left for a follow-up: one shared reader that fills a buffer pre-sized from Content-Length, for both paths | — |

The eleven new checks were first run against the unfixed build: the two
that only set the scene passed (the failure tile shows; a feed card opens
the overlay), the other nine failed — one of them only because the overlay
was already gone — and every other check passed. A broken key guard no
longer cascades: the check undoes a rotation it let through, since
rotations are remembered per artwork.

### 26.2 What this container cannot do
- The image's two `apk add` steps (arm64 build tools; the runtime ffmpeg):
  Alpine's CDN is refused (403) by this session's egress policy, so the test
  build dropped those two lines and added the proxy's CA; every `COPY` and
  `RUN` that decides what lands in `public/` is the real file's, verbatim.
- WebKit itself: the `replaceState` limit is WebKit's documented behaviour;
  the fix is proven by the call count in Chromium.

### 26.3 Before the merge
CI has never run on this branch — it runs on pull requests, and none is open.
The same steps were run here: `npm ci`'s postinstall, the build, `npm run
check`, and the blocking `npm audit --audit-level=critical` (exit 0; the one
new dependency is `pdfjs-dist`, locked at 6.4.299).

Re-verified on the fixed build: `npm run check` green (agent routes 203/0,
collector-file view gate 18/0, the bundle guard); `scripts/e2e/zine.mjs`
**176/0** (165 at §25, plus the eleven above); `scripts/e2e/model-media.mjs`
88/0; the showcase on Arjan's file green (timed in the page: desktop page 1
in 774 ms, phone 721 ms, the optimized file 622 ms). No `next-server` left
behind.

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

**Assumed at the time of the design, measured since (§21.4).** The artwork
route's bundle delta: under the 10 % guard on every build, no baseline bump
(`check:bundle`). Page-1 render time on a scanned page: ~150 ms for a 300 dpi
A4 scan in Chromium, so the ≤ 300 ms assumption held there — the ~1 s to the
first page is the file's parse and the image decode on top of it, and
Safari's JavaScript JPEG decode remains the open measurement (§21.6). WebP in
`toBlob`: not needed; every page blob is JPEG.
