# Pre-merge line review — 3D model loading, "optimize for web", collector-file cap (2026-09-29)

Branch `claude/focused-bell-pifx3b` against its merge-base with `main`
(`dcc30a6`; `main` has since moved and the branch merges onto it cleanly).
Every line the branch adds or changes, walked in order, with one question
asked of each:
what evidence shows it earns its keep? Where the answer was "none", the line
is gone; where the answer is an argument rather than a measurement, it says
so, so a reviewer can weigh it rather than take it on faith.

This is the second pass. The first (GLB_3D_VIEWER_DESIGN.md §16) worked per
construct and removed eight things. This pass re-read the diff line by line
with the first pass's conclusions deliberately set aside, and found five more:
three E2E assertions that could not fail (one of them hiding an ambiguous
selector), a toast read that had been passing on timing, two copies of a
helper, a same-tick re-entry window in the mint form, and two lines of
duplicated or over-permissive text. They are fixed on this branch (§ "What
this pass changed"), and the suite was re-run after the fixes rather than
trusted from its last green — which is how the timing bet came to light.

## Evidence key

| Key | Meaning |
|---|---|
| **V:F** | a named check in `verify:model-fetch` (39 checks, mocked fetch) |
| **V:M** | a named check in `verify:model-media` (62 checks) |
| **V:C** | an assertion in `verify:collector-file` |
| **E** | a named assertion in `scripts/e2e/model-media.mjs` (88, real Chromium, production build) |
| **H** | a run of the standalone harness recorded in GLB_3D_VIEWER_DESIGN.md "The artist's fourth round" |
| **S** | a primary source read first-hand this round, file and line where it matters |
| **R** | reasoned only: an argument, not an independent observation |

Line numbers are those of the files as committed by this review.

---

## lib/media/modelFetch.ts (new, 264 lines)

| Lines | What | Verdict | Evidence |
|---|---|---|---|
| 1–2 | imports: `GLB_HEADER_BYTES`, `GLB_MIME`, `hasGlbMagic`, `formatCfileSize` | keep | all four used below (L186, L225, L209, L261–263); relative `.ts` imports so the verify script loads the module under plain Node, the pattern `lib/media/gatewayFetch.ts` set |
| 4–36 | header comment: why the download is ours; the four model-viewer defects | keep — every claim checked | "aggregate progress… 0.5": **H** harness A/B (chip "50%", a single `environment-update` event, nothing after); **S** `progress-tracker.js` formula `total += Δ·(1−total)/progressLeft`. "88% without Content-Length": **H** harness C. "no timeout, no abort": **S** `progress-tracker.js` comment "no built-in notion of a time-out"; google/model-viewer#2593 (open); three PR #31276 (r179 `abort()`), never called by `CachingGLTFLoader.js`. "caches a failed load": **H** failcache run (second mount → `error`, zero requests; `clearCache` undefined on the element class); **S** `CachingGLTFLoader.js` 152–156 (`.catch(… return new GLTFInstance())` stored in the cache). "20 s cache lock": **S** Chromium `http_cache_transaction.cc` `AddCacheLockTimeoutHandler` (`20 * 1000`). "one transient extra copy… released on load": L223–226 of MomentModel.tsx, **E** post-load assertions run with the model rendered |
| 38–41 | `MODEL_FETCH_STALL_MS = 20_000` and its comment | keep | **E** "…within the watchdog window (20 s of silence), not a browser timeout" (measured 15–40 s); **V:F** "stall: gave up within the watchdog window". The number: above arweave.net's ordinary first byte, below the proxy's own 30 s header race (`/api/img` `RACE_TIMEOUT_MS`), so a direct-then-proxy walk stalls for at most ~50 s |
| 42–44 | `MODEL_FETCH_TIMEOUT_MS = 5 min` and its arithmetic | keep | **V:F** "hard timeout bounds a drip the watchdog would tolerate". 30 MB = 240 Mbit; at 1 Mbit/s that is 240 s — the comment's "~4 minutes" is right |
| 45–48 | `MODEL_FETCH_MAX_BYTES = 64 MiB` | keep | **V:F** "declared size over the cap is refused before any byte", "undeclared body over the cap is refused mid-stream". Twice `MODEL_MAX_BYTES` (30 MB, `lib/media/modelMedia.ts`); the agent mint path caps at 25 MB; metadata written elsewhere can point anywhere |
| 50–55 | `ModelFetchProgress { loaded, total }` | keep (trimmed) | both fields read by `modelLoadReadout` (L258) and MomentModel's throttle (L162). The first pass removed `attempt`: no reader |
| 57–63 | `ModelFetchFailure` six variants | keep | each produced by a named check: http (**V:F** "502 on the first url…", "all urls failing…"), stall ("stall: every url tried…", "no headers within the window…", "mid-body silence…"), timeout ("hard timeout…"), network ("a fetch that throws…", "a response with no body…"), too-large (two checks), not-glb ("HTML body is not accepted…", "an empty body…", "all urls failing…") |
| 65–68 | `ModelFetchAttempt { url, failure }` | keep | read by `describeModelFetchFailure` and by every `attempts[i].failure.kind` assertion |
| 70–78 | `ModelFetchError` (message from `describeModelFetchFailure`, `attempts` kept) | keep | **V:F** "stall: every url tried, error names both reasons in order" (`instanceof`, order); MomentModel L192–194 shows `err.message` verbatim |
| 80–94 | `describeModelFetchFailure`: too-large wins; any stall/timeout → retry copy; else generic | keep | **V:F** "too-large copy names the size", "stall: the copy tells the viewer to retry", "generic failure copy when nothing stalled", "describe: too-large wins over a stall elsewhere in the walk"; **E** E3 shows the generic copy on screen |
| 96–98 | `isAbortError` (name check, object-safe) | keep | **V:F** "isAbortError: recognises DOMException and plain objects, rejects others"; a plain-object form exists because a mocked fetch may reject with a non-DOMException |
| 100–110 | `FetchModelOptions` | keep | every field driven: `onProgress` (**V:F** success #1), `signal` (cancel checks), `stallMs`/`timeoutMs` (stall/timeout checks), `maxBytes` (undeclared-body check), `fetchImpl` (all). The `signal` doc sentence is what MomentModel relies on at L189 |
| 112–114 | `abortError()` | keep | used twice (L141, L228); **V:F** "an already-aborted signal throws before any fetch" needs a reason when `signal.reason` is unset |
| 116–124 | function comment | keep | each sentence restates a checked behaviour (below) |
| 125–137 | signature returning `Promise<Blob>`, option defaults, `attempts` | keep (trimmed) | the result object was trimmed to the Blob: MomentModel reads nothing else (L182). Defaults are the three constants above |
| 139–141 | loop; pre-aborted signal throws | keep | **V:F** "an already-aborted signal throws before any fetch" (zero calls) |
| 143–150 | per-attempt controller; `fail()` sets the first cause then aborts | keep; guard **R** | every stall/timeout/too-large/not-glb check goes through `fail()`. The `if (!failure)` covers a stall and the hard timeout firing in the same tick, which no check provokes; one line |
| 151–152 | outer abort forwarded to the attempt | keep | **V:F** "cancel mid-download throws an AbortError", "cancel does not walk to the next url", "cancel releases the body" |
| 153–158 | hard timer; stall timer; `armStall()` | keep | **V:F** "hard timeout…"; "no headers within the window is a stall" (timer runs from the request, not the first byte); "mid-body silence is a stall" (re-armed per chunk) |
| 161 | `fetchImpl(url, { signal, credentials: 'omit' })` | keep; `credentials` **R** | the signal is what every abort check relies on. `credentials: 'omit'`: the proxy route reads no session and the gateway is cross-origin, so no request here has a use for the session cookie; the default would send it to `/api/img` on every model load |
| 162–166 | `!res.ok` → http failure, body cancelled | keep | **V:F** "502 on the first url walks to the second"; "all urls failing throws with one entry per url" (`http,http,not-glb`) |
| 167–173 | Content-Length parsed only if all digits; declared over cap refused | keep | **V:F** "declared size over the cap is refused before any byte" (and its body cancelled); the digit test is why a garbage header falls to `total = null` rather than `NaN` |
| 174–177 | `!res.body` → network | keep | **V:F** "a response with no body is a network failure" |
| 179–182 | re-arm on headers; first progress `{0, total}` | keep | **V:F** "first progress event is 0 of the declared total"; the E2E's "connecting" readout is what shows before this line runs |
| 184–189 | reader, chunks, 12-byte head, flags | keep | all read below |
| 190–193 | read loop; `done` breaks; re-arm per chunk | keep | **V:F** "progress is monotonic and ends at the total"; "mid-body silence is a stall" |
| 194–199 | byte cap on actual bytes | keep | **V:F** "undeclared body over the cap is refused mid-stream" |
| 200–204 | accumulate the first 12 bytes | keep | feeds L208–215 |
| 205–215 | magic check at ≥4 bytes; early cancel | keep | **V:F** "HTML body is not accepted as a model; the walk continues", "HTML body was cancelled early rather than downloaded whole", "all urls failing…" (`nope`) |
| 216–217 | push chunk; progress | keep | **V:F** success #1 (bytes complete, monotonic) |
| 219 | `if (failure) continue` after a `break` | keep | **V:F** too-large mid-stream and not-glb both reach here with `failure` set |
| 220–224 | fewer than four bytes → not-glb | keep | **V:F** "an empty body is recorded as not-glb, not as success" |
| 225 | return the typed Blob | keep | **V:F** "blob has every byte and the GLB MIME", "blob bytes start with the glTF magic"; **E** "the viewer is handed a blob: URL" |
| 226–232 | catch: caller's abort rethrown; watchdog keeps its reason; else network | keep | **V:F** cancel checks; stall/timeout checks (reason preserved); "a fetch that throws is a network failure, and the walk continues" |
| 233–241 | finally: timers, listener, record the attempt | keep | **V:F** "stall: every url tried, error names both reasons in order" — the check that failed when this record sat after the `try` and the `continue`s skipped it |
| 244 | throw with the whole walk | keep | **V:F** "all urls failing throws with one entry per url" |
| 247–264 | `modelLoadReadout` and comment | keep | **V:F** connecting / preparing / "14% · 4 MB of 28 MB" / "15% · 4.3 MB of 28 MB" / "4 MB" / clamp at 100%; **E** "before any byte the readout says connecting, never a percentage"; the NN/g sentence: **S** nngroup.com progress-indicator guidance (snippet-verified by the research pass) |

## lib/media/gateway.ts (+20 lines)

| Lines | What | Verdict | Evidence |
|---|---|---|---|
| comment block | why the proxy is always the last URL | keep | claims: pool is one host (**S** `lib/arweave/gateways.ts` `ARWEAVE_GATEWAYS`), proxy races server-side with a 30 s budget (**S** `app/api/img/route.ts` `RACE_TIMEOUT_MS`) and caches immutably (**S** same file, `Cache-Control` header) |
| `modelFetchUrls(uri)` body | direct-first via `videoGatewayUrls`, proxy appended once | keep (parameter removed) | **V:F** "walk: direct gateway first, proxy guaranteed last…", "…ipfs walks its pool then the proxy", "…a plain https model has exactly one route"; **E** E2 is the proxy rescuing a stalled direct gateway. `forceProxy` was removed by the first pass: no caller; the model is fetched after a tap, client-side, so the SSR hint has nothing to hint |

## lib/media/modelViewerConfig.ts (new, 38 lines)

| Lines | What | Verdict | Evidence |
|---|---|---|---|
| 1–22 | comment: the constructor re-reads the global; the static setter never held | keep — the central claim of the fix | **S** `@google/model-viewer/lib/features/loading.js` 243–246: `const ModelViewerElement = self.ModelViewerElement || {}; … setDRACODecoderLocation(ModelViewerElement.dracoDecoderLocation || DEFAULT…)` inside the element constructor; the ESM entry never assigns `self.ModelViewerElement` (grep of `lib/model-viewer.js` and the dist module: reads only). **H** decode harness: with the static setter, no request reached `/model-decoders/`, the load failed against gstatic. **E** "the Draco decoder that served was the SELF-HOSTED one, not gstatic" |
| 24–25 | the two locations | keep | **E** 200s for `draco_wasm_wrapper.js`, `draco_decoder.wasm`, `draco_encoder_wrapper.js`, `draco_encoder.wasm` under `/model-decoders/draco/`; the basis path is the pre-existing one |
| 27–30 | the global's shape | keep | typed to the two keys written |
| 32–38 | `configureModelViewerDecoders()` | keep; L33 **R** | **E** as above, at all three mount sites (the collector viewer is not driven; it calls the same function). L33's `typeof self` guard is unreachable today (every caller runs after a client-only dynamic import) and is what makes the function safe to call from any module — the contract `lib/media/gateway.ts`'s helpers keep with their `typeof window` guards |

## components/MomentModel.tsx (rewritten, 346 lines)

| Lines | What | Verdict | Evidence |
|---|---|---|---|
| 1–16 | imports | keep | each used: `Box`/`X` (buttons), `MomentImage` (still), `modelFetchUrls`, `thumbhashToBlurDataURL`, the three `modelMedia` exports, the four `modelFetch` exports, `configureModelViewerDecoders` |
| 18–57 | component comment | keep — claims checked | tap-to-load rationale is inherited; "no WebGL context exists until the model is in hand": **E** "no WebGL context exists while the bytes are still on their way"; "host is position:relative": **S** `template.js` 21–27; "empty white box": **H** harness A (centre pixel 255,255,255); "pixel-checked": **E** centre-pixel assertions; "exiting aborts": **E** E4 |
| 59–76 | `Phase`, `Props` | keep | every prop read (`background` at L252, `onAllError` via ref at L246) |
| 78–96 | `useAllowsMotion` (unchanged) | keep | **E** D |
| 99–109 | six state values | keep | each drives a rendered outcome the E2E observes: `phase` (all sections), `message` (E3, E5), `posterFailed` (still fallback), `modelLoaded` (fade), `download` (readout), `blobUrl` (src) |
| 113–115 | `abortRef`, `blobUrlRef`, `sessionRef` | keep; `sessionRef` **R** | abort: **E** "the in-flight request was actually aborted"; blob URL: **E** "handed a blob: URL"; session token: E4's "a response arriving after the cancel never mounts a viewer" passes via the abort alone — the token is what would still discard a result resolved in the same tick as the cancel |
| 116–118 | `lastProgressAtRef` | keep **R** | not measured: a 30 MB body arrives as roughly 500–2000 stream chunks and each `setDownload` re-renders the media column; the final event bypasses the throttle (L162–163), so the last state is never lost |
| 119–121 | `urls` memo | keep | **V:F** walk checks; memo rationale inherited (the helper sniffs `window.top` and the UA) |
| 123–125 | motion; `onAllError` ref | keep (inherited) | **E** D; the ref keeps the effect at L245 free of a changing callback |
| 127–133 | `releaseBlob` | keep | **E** "exiting unmounts the viewer"; E5 (blob released on a parse failure); L129 guards the double-revoke after `onLoad` |
| 135–141 | `cancel`: bump session, abort, drop blob | keep | **E** E4 (both assertions); "exiting unmounts the viewer (releases the context)" |
| 143–151 | `activate` start: cancel, new session, controller, reset per-load state | keep | **E** E3 "retry re-fetches — new requests were made" (the reset is what makes retry a fresh walk); the `cancel()` first is why a re-tap mid-download cannot leak the previous fetch |
| 152–168 | element import ∥ fetch; throttled progress | keep | **E** C (loads), E/E2 (readout states); the parallel `import()` keeps the ~475 KB chunk from being serialised behind the download (**S** bundle note in the component comment, measured in the design doc's implementation record) |
| 169 | stale-session return | keep | the E4 contract (L110–112) |
| 170–178 | decoder config | keep | **E** self-hosted decoder assertions (see modelViewerConfig) |
| 179–185 | blob URL per attempt; `active` | keep | **E** "handed a blob: URL, never a gateway URL model-viewer could cache"; **H** failcache is why the URL must be fresh |
| 186–198 | catch/finally | keep; L188 **R** | **E** E3 (error copy from `ModelFetchError`), E4 (`isAbortError` → silent). L188 `controller.abort()` on an element-import failure is not driven; it stops a download for a viewer that can no longer exist. L197 keeps `abortRef` honest after success (the second pass confirmed nothing else clears it) |
| 201–207 | `exit` | keep (trimmed) | **E** "exiting unmounts…", E4 "cancel returns to the idle affordance immediately". The first pass removed three resets: the idle branch reads only `phase`, `message`, `hasStill`; `message` is only set from an error phase, which renders no exit control |
| 209–211 | unmount → `cancel()` | keep **R** | navigation mid-download is not driven; one line, releases the fetch and the blob |
| 213–241 | `attach`: `load` (fade + revoke), `error` (model's fault) | keep | `load`: **E** "the still fades only AFTER the model paints"; revoking on load is safe by **S** `model-viewer-base.js` `$updateSource` early return when `src` is unchanged, and every post-load E2E assertion runs with the model still rendered. `error`: **E** E5 (four assertions: copy names the model, one request only, viewer unmounted with retry, still kept) |
| 243–247 | `hasStill`, `onAllError` effect (unchanged) | keep | inherited |
| 249–252 | blur, viewer colour | keep | **E** C2 (`transparent` → wrapper `rgba(0,0,0,0)`) |
| 254–273 | the still (image or blur) | keep | **E** "the still paints before any tap", centre-pixel poster checks; the blur branch is the pre-existing fallback |
| 275–276 | branch: loading or active-with-blob; `parsing` | keep | **E** "the still layer stays opaque while model-viewer parses the blob" — `parsing` is the "preparing" readout state |
| 278–287 | wrapper carries `backgroundColor`; still layer fades on `modelLoaded` | keep — the layering fix | **E** "…SAME backdrop as the still, carried by the wrapper", "the element itself stays transparent so the still shows through until load", "centre pixel is the poster, not the backdrop"; **H** harness F/G/H/I (opaque on the element hides the still; on the wrapper it does not) |
| 288–303 | `<model-viewer>` only with a blob URL; attributes | keep | **E** "tapping mounts exactly one viewer", shadow-intensity, environment-image, D (auto-rotate), "handed a blob: URL"; `touch-action="pan-y"` inherited |
| 304–311 | readout chip | keep | **E** "before any byte the readout says connecting…", "a cancel control is offered…"; `whitespace-nowrap` keeps "14% · 4.3 MB of 28 MB" on one line (screenshot 09). The chip's contrast reasoning is inherited from finding 16 |
| 312–319 | exit / cancel control with two labels | keep | **E** "exit control is present and labelled", "a cancel control is offered during the download", E4 |
| 324–346 | idle/error branch: still, `view in 3D` / `retry 3D`, message | keep (trimmed) | **E** "idle state offers view in 3D", E3 "the failure is explained and the retry affordance is offered", E5. The first pass removed `disabled={urls.length === 0}`: `gatewayUrls` returns `[uri]` for any non-empty string and the parent mounts this component only with a non-empty `modelSrc` |

## components/ModelOptimizeBar.tsx (new, 55 lines)

| Lines | What | Verdict | Evidence |
|---|---|---|---|
| 1–4 | client directive; imports (`formatCfileSize`, `OptimizeStep` type) | keep | both used; the type import erases at build |
| 6–11 | comment | keep | matches the three rendered states below |
| 12–24 | props | keep | each rendered or wired: `size`, `busy`, `optimized.before`, `onOptimize`, `onUndo` — **E** G chip texts, G undo, G2 |
| 26–29 | container; `aria-live="polite"` | keep; `aria-live` **R** | the chip's text changes while the artist waits (reading → textures → geometry → writing) and is the only status the form shows; announcing a status region is the standard, and `verify:a11y` cannot see it (it scans contrast classes) |
| 30 | live size | keep | **E** "the chip now shows a smaller live size and what it was" (`3.2 MB`) |
| 31–32 | busy step | keep (trimmed) | rendered during the pass (the step ids are the copy; the identity map that used to translate them was removed) |
| 33–43 | "was …" + undo | keep | **E** "…and what it was" (`was 13.4 MB`), "undo restores the original file and size" |
| 44–52 | "optimize for web" | keep | **E** "the size chip offers optimize for web on a 3D pick", G2 "a new pick clears the optimized record — the chip offers the pass again" |

## components/MintForm.tsx (+63 lines, −3)

| Hunk | What | Verdict | Evidence |
|---|---|---|---|
| imports | `ModelOptimizeBar`, `OptimizeStep` type | keep | both used |
| `replace: replaceFile` | the hook's new method | keep | **E** G ("the preview re-loads from the OPTIMIZED bytes"), G undo |
| `optimizing`, `optimized` state; `optimizeRunningRef`; `fileRef` | pass state, a synchronous re-entry guard, a stale-pick guard | keep; both refs **R** | **E** G/G2 drive the two states. `optimizeRunningRef` (added by this pass): React state only changes on the next render, so two clicks in one tick would start two passes and race `replaceFile`; a ref closes that window. `fileRef`: the same race the hook guards with its own pick token — not driven |
| warning copy | figures from the published guidance | keep | **E** "a model over 8 MB gets the size warning, citing the published guideline"; **S** Khronos real-time asset guidelines 1.0 ("ideally less than 5MB"), model-viewer discussion #2716 (">20mb… danger zone") |
| effect: `setOptimized(o => o && o.file !== file ? null : o)` | a different pick drops the record | keep | **E** G2 "a new pick clears the optimized record — the chip offers the pass again, with no was" |
| `optimizeModelPick` | guard, lazy import, run, stale check, unchanged toast, replace + record + toast, error toast, finally | keep; error toast **R** | **E** G ("the pass completes and reports what it did", Draco, texture), G2 ("…without error", "…the answer is honest") — the G2 run answered "Already compact", so the `unchanged` branch is driven. The error toast is not driven; it is the only surface for a meshopt input or a malformed export |
| `<ModelOptimizeBar …/>` | wiring; `optimized` shown only while its file is the pick; undo restores through the gate | keep | **E** G, G2 |
| collector-file toast | derived from the constant | keep | **V:C** `formatCfileSize(CFILE_MAX_BYTES) === '64 MB'` |

## hooks/useFileUpload.ts (+4 lines)

| Hunk | What | Verdict | Evidence |
|---|---|---|---|
| `replace(f)` | runs the same `accept` (size and type gate) as a pick | keep | **E** G: the optimized file is installed through the gate and the preview remounts on a new `blob:` URL; G undo. The comment's claim — "nothing can bypass the checks by arriving programmatically" — is the function body |

## lib/media/optimizeModel.ts (new, 233 lines)

| Lines | What | Verdict | Evidence |
|---|---|---|---|
| 1 | import `GLB_MIME`, `isWellFormedGlbHeader` | keep | L227, L219 |
| 3–30 | header comment: textures first; Draco over meshopt; what is not touched | keep — claims checked | textures dominate real files: **H** Node dry run (50 MB texture vs 1.8 MB geometry on the synthetic sphere; the E2E fixture is 13.4 MB of which the PNG is nearly all). Draco vs meshopt: **S** gltfpack README ("make sure that your content delivery method is configured to use deflate (gzip)"); neither `app/api/img/route.ts`'s passthrough nor arweave.net's responses (chunked, per the codebase's own `readBodyBounded` note) promise it; the decoder is self-hosted. "already compressed with meshopt… cannot be read": no meshopt decoder is shipped (grep of public/model-decoders) |
| 32–33 | `OPTIMIZE_MAX_TEXTURE_PX = 2048` | keep | **E** "…the 3000px texture was downscaled to 2K"; **S** Khronos guidelines (1K/2K textures) |
| 35 | `OptimizeStep` | keep | rendered by the chip; typed at the MintForm state |
| 37–45 | `OptimizeResult` | keep | every field read by `optimizeModelPick` (`file`, `before`, `after`, `applied`, `unchanged`) |
| 47–48 | `DRACO_DIR`, `JSON_CHUNK` | keep | L90–91, L118 |
| 50–53 | `EmscriptenFactory` (callback required) | keep (tightened) | the callback is always passed (L100); the first pass removed the promise branch |
| 55–76 | `loadScript` | keep; two branches **R** | **E** "the encoder the pass used was self-hosted too" (the wrapper served 200 through this path). The `existing` branch (L57–59, L70–74) is reached only if the script loaded but the wasm fetch failed and the artist retries; the `error` branch removes the tag so that retry can succeed. Neither is driven |
| 78–100 | `loadDracoModule`: memoized; script ∥ wasm; factory called with `onModuleLoaded` | keep (simplified) | **E** G (encoder), G2 (decoder path — "an already-Draco input is read (decoder)…"); **S** Draco 1.5.7 `draco_encoder_wrapper.js` calls `a.onModuleLoaded(a)`; three's `DRACOLoader.js` 510–517 relies on that callback alone. L96–97's `typeof factory` check turns a wrong global into a message instead of a TypeError |
| 101–108 | cache eviction on failure; the memo entry; return | keep **R** | a failed load must not be memoized as a permanent failure (the exact model-viewer defect this branch fixes elsewhere); not driven |
| 110–129 | `declaredExtensions` (exported for the oracle) | keep | **V:M** five checks: used+required, none, header-only, wrong chunk type, truncated chunk |
| 131–156 | `shrinkTexture` | keep | **E** "…3000px texture was downscaled to 2K"; L134 skips KTX2/other; L138 leaves ≤2K alone; L152 keeps the original when a canvas re-encode is larger (a PNG with a palette re-encodes as RGBA and can grow) |
| 158–169 | signature; `reading`; meshopt refusal | keep; refusal **R** | **E** G; no meshopt fixture (the encoder is not a dependency) — the refusal is the honest answer while no decoder is shipped |
| 170–188 | lazy imports; encoder always, decoder only for Draco input; `WebIO` with all extensions | keep | **E** G (no decoder needed), G2 (decoder loaded and the write re-encodes: **S** glTF-Transform's `KHRDracoMeshCompression` encodes at write, so the encoder is required for Draco input too — observed: the G2 pass completed without error) |
| 189–203 | read; texture pass; `applied` line | keep | **E** G toast "…texture downscaled to 2048px" |
| 205–215 | `dedup`, `prune`; Draco unless already Draco; unsupported primitives keep their geometry | keep; catch **R** | **E** G "Draco compressed the geometry"; **H** Node dry run (geometry 1.77 MB → 81 KB; round-trip decodes). The catch is not driven (no points/lines/morph fixture) |
| 217–224 | write; header check; not-smaller → unchanged | keep | **E** G2 "Already compact" (the `unchanged` branch), G (the smaller branch); the header check is `isWellFormedGlbHeader`, the same gate the mint applies to a pick |
| 225–232 | the File, named after the input | keep | **E** G ("the preview re-loads from the OPTIMIZED bytes"), G2 reads the bytes back as a GLB carrying `KHR_draco_mesh_compression` |

## components/ModelPreview.tsx (+3, −2) and components/CollectorFileViewer.tsx (+6, −3)

| Hunk | What | Verdict | Evidence |
|---|---|---|---|
| import + `configureModelViewerDecoders()` in place of the two static setters | | keep | **E** G ("the preview re-loads from the OPTIMIZED bytes"), G2 ("a Draco model picked directly renders in the preview"): the mint preview decodes Draco through the self-hosted files, which the static setters never achieved (**H** decode harness). The collector viewer is not driven (needs a holder session) and calls the same helper |
| CollectorFileViewer comment "up to CFILE_MAX_BYTES (64 MiB)" | | keep | true by the constant |

## Collector-file cap

| Hunk | What | Verdict | Evidence |
|---|---|---|---|
| `lib/collectorFileTypes.ts` `CFILE_MAX_BYTES = 64 MiB` and comment | value and the numbers it cites | keep | **V:C** value; sixteen 4 MiB chunks; resident bytes 89,478,544 (the "~85 MiB"); "~150 MB in the PUT slot" = 2.3 × 64 MiB; **S** Upstash limits (10 MB request, 100 MB record, 200 GB/month bandwidth, $0.25/GB-month past 1 GB — docs read by the research pass, cross-checked against the codebase's own REDIS_IMPLEMENTATION_REVIEW.md §5 table) |
| `formatCfileSize`: drop a zero decimal | | keep | **V:C** `'64 MB'`, `'13.4 MB'`, `'3 MB'`, `'2 KB'`, `'512 B'`; **E** G parses the chip with a regex that accepts both forms |
| `lib/collectorFileCore.ts` comment | "8× the MBC5 ceiling" | keep | 8 MiB × 8 = 64 MiB |
| `app/api/collector-file/route.ts`: `formatCfileSize` import; two 413 strings; comments | | keep | the strings render the constant (**V:C**). The deployment note: **S** Traefik commit 240b83b (`readTimeout` default 60 s; docs: "entire request, including the body"); Coolify `bootstrap/helpers/proxy.php` (`traefik:v3.7`, no `respondingTimeouts`); coollabsio/coolify#5358 (the `5m` flag under Server → Proxy → Configuration); Next 15.5.25 `config-shared.js:219` (`middlewareClientMaxBodySize: 10485760`) and `body-streams.js` 85–99 (both clone streams end at the cap; `console.warn` only). "~9 Mbit/s": 64 MiB × 8 / 60 s ≈ 8.9 Mbit/s |
| `download/route.ts` comment | "~150 MB… ~300 MB for two" | keep | 2.3 × 64 MiB ≈ 147 MB; two slots |
| `CollectorFileManagePanel.tsx`: toast and helper text | | keep | render the constant (**V:C**); `formatCfileSize` was already imported there |
| `.env.example` | ceiling note | keep (one duplicate sentence removed by this pass) | 3 retained versions × ~85 MiB ≈ 256 MiB against a 512 MiB default |

## lib/arweave/gateways.ts (+10 comment lines)

| What | Verdict | Evidence |
|---|---|---|
| second-gateway follow-up; why the host is not added | keep | **S** ar.io Wayfinder docs (arweave.net "single point of failure… performance bottleneck"); ar-io/ar-io-node#882 (429s on turbo-gateway.com); the file's own rule requires a `curl -I` this sandbox cannot make (egress blocked, checked). The proxy-as-second-route claim is `modelFetchUrls` (**V:F**) |

## public/model-decoders

| What | Verdict | Evidence |
|---|---|---|
| `draco_encoder_wrapper.js` (49,007 B), `draco_encoder.wasm` (370,188 B) | keep | sha256 of the wasm equals `draco3d@1.5.7`'s (`d2a3ac80…`); wrapper from `google/draco` tag 1.5.7; **E** both served 200 during the pass; README records the refresh commands |
| README additions | keep | describe exactly the files above and the loader in `optimizeModel.ts` |

## package.json, package-lock.json

| What | Verdict | Evidence |
|---|---|---|
| `verify:model-fetch` script; added to `verify:flows` | keep | runs in `npm run check` via `verify:flows`; 39 checks |
| `@gltf-transform/{core,extensions,functions}@4.5.1` (exact) | keep | imported only inside `optimizeGlb` (dynamic) — **check:bundle**: no route grew; the code sits in lazy chunks. Lockfile diff contains these three and their transitive dependencies only (checked: no `playwright` entries) |

## scripts/verify-model-fetch.ts (new, 39 checks)

| Lines / block | What | Verdict | Evidence |
|---|---|---|---|
| header, imports | | keep | every import used (`GLB_MAGIC`, `GLB_MIME`, `modelFetchUrls`, the module's exports) |
| `check`, `sleep`, `glb`, `split` | helpers | keep | each used ≥5 times |
| `RouteSpec` + `mockFetch` | a fetch whose streams honour the request's AbortSignal | keep | every field drives a case: `status` (#3, #11), `chunks`/`gapMs` (#1, #4, #7, #8, #10), `hangHeaders` (#6), `hangBeforeBody` (#5), `hangAfterBody` (#7), `contentLength` number/'none' (#9a, #2, #9b). The abort listener records a cancellation because a real fetch releases the body on abort — the first draft asserted a `cancel()` the errored stream could never call |
| cases #1–#12 | see the module table above | keep | each check is the evidence for a line of `modelFetch.ts` |
| case #13 (walk) | `modelFetchUrls` shapes | keep | the three shapes production can produce (Node has no window, so the top-level order is the one exercised) |

## scripts/verify-model-media.ts (+45), scripts/verify-collector-file.ts (+18)

| What | Verdict | Evidence |
|---|---|---|
| `glbWithJson` fixture builder + five `declaredExtensions` checks | keep | pins the glTF 2.0 binary chunk offsets (12 length, 16 type, 20 payload) that decide decoder loading; imports `optimizeModel.ts` under Node without touching the DOM (module scope holds only constants and functions) |
| cap value, chunk count, resident bytes, formatter outputs | keep | see the cap table; the resident-bytes figure is the one the design doc and the types file cite |

## scripts/e2e/model-media.mjs (+411)

| Block | What | Verdict | Evidence |
|---|---|---|---|
| `import sharp` | the textured fixture's PNG | keep | used by `makeTexturedGlb` only; sharp is a project dependency |
| `makeTexturedGlb` | ~29k-triangle UV sphere, 3000 px PNG albedo, spec-valid GLB | keep | G's "3000px texture was downscaled", "Draco compressed"; 13.37 MB in the passing run; every buffer view is referenced (indices, positions, UVs, image) |
| `MEDIA_INPUT` selector + "uniquely addressable" check | the media input addressed by its own accept list; count must be 1 | keep (fixed by this pass) | the previous selector matched the collector-file input as well (the E2E's own strict-mode error, reproduced on the rebuilt bundle, names both inputs); every `setInputFiles` in the file goes through this constant |
| `pixelOf`, `centerOf`, `cornerOf` | one in-page PNG pixel reader; corner and centre variants | keep (unified by this pass) | the centre read is the still-visibility assertion in E and E2; the corner read is the backdrop assertion in A. The first pass left two copies of the decoder; now one |
| `isPosterGreen`, `mediaBoxOf`, `readoutOf` | fixture colour, the media wrapper via the exit/cancel control, the chip text | keep | used by E, E2 (all three) |
| C: wrapper vs element background | | keep | the layering fix's direct assertion; C2 reads the wrapper for `transparent` |
| E: connecting, no WebGL yet, centre pixel, cancel control, opaque during parse, `blob:` src, fade | | keep | each names a product behaviour; the `src` is read as a property because React 19 sets it as one (the first run read the attribute and got `null`) |
| E2: held route, request log, "connecting" + still during silence, proxy delivery, elapsed window, route abort | | keep | the artist's failure reproduced and escaped; `heldRoute.abort()` releases Playwright's pending handler |
| E3: 404/502 routes, request count, copy, still, `gatewayUp` flip, re-fetch count, loaded | | keep (one assertion made real by this pass) | "…and the model loads once the gateway is back" now evaluates `loaded`; it read `true` before |
| E4: delayed route, `requestfailed` log, cancel, idle, no viewer after the delay, aborted | | keep | the `.catch(() => {})` on the late `fulfill` is required: Playwright throws when a cancelled request is fulfilled |
| E5: `corrupt` bytes, one request, copy, unmounted + retry, still | | keep | the parse-failure path of `attach`'s `error` handler |
| G: decoder/encoder response log, pick (toast-tolerant), warning copy, chip, optimize, toast contents, remount wait on `src`, chip after, decoder/encoder 200s, undo | | keep | the toast-tolerant pick exists because the fixture is over 8 MB and `pickMedia` treats any toast as a rejection; the remount wait anchors on the previous `src` because `replace()` mints a new blob URL |
| G2: `srcAfterUndo` anchor, optimize, read the bytes back through the blob URL, magic + extension check, pick as a fresh file, remount wait, chip cleared, empty-stack wait, pass on Draco input, honest toast | | keep (three things fixed by this pass) | the anchor was wrong in the first run (undo had already changed the src, so the wait resolved on the un-optimized bytes); one assertion was `true`; and the toast read sliced the stack's tail, which is its oldest toast under sonner's newest-first order (**S** `sonner/dist/index.js`, the `[toast, ...toasts]` update) — it now waits for an empty stack first. All three now assert what they claim; the run answered "Already compact" |
| README count and coverage text | | keep | 88 assertions counted from the passing run |

## GLB_3D_VIEWER_DESIGN.md, COLLECTOR_DOWNLOADS_DESIGN.md, scripts/e2e/README.md, public/model-decoders/README.md

Prose. Every quantitative claim in the added sections is one of the **S**/**H**/**V**/**E** items above; the two figures corrected during the audit (fetch-suite count 32 → 39; e2e 78 → 88) are the counts of the passing runs.

---

## What this pass changed (on top of §16's eight removals)

1. **Three assertions that could not fail.** E3's "…and the model loads once the gateway is back" and G2's "a Draco model picked directly renders in the preview" were `check(name, true)` — green by construction. Both now evaluate the element's `loaded` (and, for G2, that its `src` changed). A pre-existing one on `main` ("media input advertises .glb in its accept list") was the third, and making it real exposed what it had been hiding: the selector behind every media pick, `input[accept*="model/gltf-binary"]`, matches two inputs on the mint form, because the collector-file picker accepts a `.glb` too. Page-level `setInputFiles` is not strict and had been feeding the first match — the media input only while the DOM order holds; the strict locator the real assertion needs threw at once. The selector is now anchored on the media input's own list (`accept^="image/*"`), and the assertion also checks that it resolves to exactly one element, so a future third GLB-accepting input fails the suite instead of silently redirecting every pick.
2. **A swallowed wait, and the timing bet under it.** G2 carried `.nth(1).waitFor(…).catch(() => {})` before its first optimize; the `src`-change wait that follows is the real gate, so the line went. The re-run then failed G2's last assertion, and the failure was not the removed line's: the toast read after it counted the toast stack and sliced the tail, which assumes new toasts are appended, while sonner 2.0.7 prepends them (`[toast, ...toasts]` in the Toaster's subscription, `node_modules/sonner/dist/index.js`) — the tail is the oldest toast. Every earlier green run had taken the count after the previous toast expired (3 s), so the slice was empty and the read happened to be right. The read now waits for an empty stack (bounded at 20 s, so a toast that never expires is loud) and treats everything present after the click as this pass's answer.
3. **Two copies of the PNG pixel reader** (`cornerOf`, `centerOf`) — now one `pixelOf(pg, locator, where)`.
4. **A re-entry window in the mint form:** `optimizeModelPick` gated on React state, which changes a render later; two clicks in one tick would start two passes and race `replaceFile`. A ref now closes it.
5. **A duplicated sentence** in `.env.example` and an optional callback type that is always passed (`EmscriptenFactory.onModuleLoaded`).

Why the first pass missed 1–2: a passing count cannot see an assertion whose condition is a literal. The repo's E2E README already warns about vacuous passes from a different cause (hydration races); `grep -n "check(.*, true)"` is the check for this one, and it now returns nothing. The selector ambiguity under item 1 is the concrete cost of a literal assertion: the one check that would have caught it was the one that could not fail. Item 2 is the other way a green run lies: an assertion that is real but whose input is chosen by timing. Both surfaced only because the suite was re-run after the cleanup rather than trusted from its last green.

## Validation of the branch as reviewed

typecheck and lint clean; `verify:model-fetch` 39, `verify:model-media` 62, `verify:collector-file` all passing; `check:bundle` no route grew; production build clean; browser E2E 88 assertions, 0 failures, on the rebuilt bundle (the run after the G2 fix; the run before it was 87/1, the failure described under item 2 above). The repository's full `npm run check` gate was also run on the tree: every step passed, with one caveat worth recording — `verify:collect-record` (an oracle this branch does not touch, which starts its own local server) refused a connection while the browser E2E was running in parallel on the same container, and passed on its own immediately after, as did the two steps behind it (`verify:a11y`, `verify:agent:routes`).

## Outside the diff, for the record

- `MODEL_MAX_BYTES` (30 MB) sits above the maintainer's ">20mb danger zone"; the branch warns rather than lowers it, because a lower cap would refuse artworks already minted at that size.
- The collector viewer (`CollectorFileViewer`) and the edit flow's 3D media replacement call the same helpers but are not driven by the E2E (a holder session, an on-chain write). Their decoder path is the one line the E2E does prove on the mint preview.
- The two operational obligations that travel with the cap raise (Traefik `readTimeout=5m` in Coolify; `CFILE_STORAGE_CEILING_BYTES` to 2 GiB) are recorded on the PUT route and in the design doc; nothing in this branch can set them.
