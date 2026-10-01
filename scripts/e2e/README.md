# Browser end-to-end check — 3D moments

`model-media.mjs` drives a real Chromium against a real build and asserts the
parts of the GLB feature that only exist on screen.

## Why this is separate from `npm run check`

The 150px-strip bug (GLB_3D_VIEWER_DESIGN.md, finding 15) passed typecheck,
lint, the `verify:model-media` oracle (44 assertions at the time) **and** the
bundle guard.
None of those render a layout, so none of them could have caught a preview
that displayed — and captured its poster — at the wrong size. That is the gap
this file covers, and it is why it asserts pixel geometry and capture output
rather than just taking pictures.

It is not part of `npm run check` because it needs a built app, a running
server and a browser. Run it deliberately when the 3D path changes.

## Running it

```sh
npm run build

# 1. A stub Redis so server components render in a sandbox. Every read answers
#    "no data" — the same shape the app sees for a moment with no KV entries.
node scripts/e2e/redis-stub.mjs &

# 2. The app, pointed at the stub.
UPSTASH_REDIS_REST_URL=http://localhost:6399 \
UPSTASH_REDIS_REST_TOKEN=stub \
CRON_INPROCESS=off \
npx next start -p 3100 &

# 3. Fixtures: a spec-valid glTF 2.0 cube plus a still. The script writes the
#    rest itself (a zip, a textured sphere, truncated / old-version / corrupt GLBs).
mkdir -p .e2e && node scripts/e2e/make-glb.mjs .e2e/cube.glb
node -e "require('sharp')({create:{width:600,height:600,channels:3,background:{r:20,g:120,b:90}}}).jpeg().toFile('.e2e/poster.jpg')"

# 4. The check. Screenshots land in .e2e/shots/.
npx playwright@1.56 install-deps 2>/dev/null || true
node scripts/e2e/model-media.mjs
```

`playwright` is intentionally NOT a repo dependency — install it ad hoc
(`npm i --no-save playwright`) or point `E2E_CHROMIUM` at a browser you have.
`E2E_BASE_URL` and `E2E_DIR` override the server and fixture locations.

## What it asserts (88)

- **Mint** — the preview is square (not model-viewer's 150px `:host` default),
  a real GLB loads, `toBlob` yields a square JPEG large enough for the 800×800
  OG hero (deterministic: the preview pins the renderer's dynamic scale to 1
  while mounted — under CPU load it otherwise halves, and this suite caught a
  755px capture that way), posing changes what would be captured, the pose
  hint is visible.
- **Gate** — a zip, a truncated GLB and a glTF 1.0 binary are each rejected
  with the right copy and leave no preview mounted.
- **Detail** — the still paints first, no WebGL exists before the tap, tapping
  mounts exactly one viewer, the artist's backdrop sits on the WRAPPER behind
  the still (never on the element, whose `position: relative` host would paint
  over it), the still fades only after the model paints, exiting unmounts the
  viewer and restores the affordance.
- **Reduced motion** — `auto-rotate` is off under `prefers-reduced-motion` and
  on without it.
- **Slow load** — before any byte the readout says "connecting" (never a
  percentage: model-viewer's aggregate tracker used to read "50%" here), no
  WebGL context exists yet, the still is visible by CENTRE PIXEL (not by CSS
  opacity, which passed vacuously while an opaque backdrop covered it), a
  cancel control is offered, the viewer is handed a `blob:` URL, and the still
  fades only after the model paints.
- **Stalled gateway** — a gateway that accepts the request and never answers
  is abandoned by the 20 s watchdog and the walk reaches `/api/img`, which
  delivers the model; the readout stays honest throughout.
- **Failed walk, then retry** — every URL is tried, the failure is explained
  with the still behind it, and "retry 3D" makes NEW requests (model-viewer
  cached a failed load and could never re-fetch).
- **Cancel** — exiting mid-download aborts the request, returns to idle at
  once, and a response arriving afterwards never mounts a viewer.
- **Unparseable model** — a GLB that downloads but cannot be parsed reports
  the model rather than the network, makes no further gateway requests,
  unmounts the viewer, offers retry, and keeps the still.
- **Optimize for web** — a textured sphere (~29k tris, 3000px albedo) is
  Draco-compressed and its texture downscaled to 2K, the chip shows the new
  size and what it was, the preview re-loads from the optimized bytes (the
  self-hosted decoder decoding the self-hosted encoder's output), the decoder
  and encoder requests are proven to hit `/model-decoders/` rather than
  gstatic (the static-setter form the app used never held — see
  `lib/media/modelViewerConfig.ts`), and undo restores the original. Then the
  optimized bytes are picked again as a fresh file: a Draco model renders
  directly in the preview, the new pick clears the "was" record, and the pass
  reads Draco input (decoder and encoder) and answers honestly.
- **Backdrop** — all three options are offered, the preview renders on the
  artist's colour, switching it changes the render, the swatches meet the
  24px target-size minimum, `transparent` lets the page through the viewer
  while the thumbnail stays opaque, and model-viewer's own JPEG is black
  while its PNG keeps alpha (the reason the capture composites itself rather
  than asking for a JPEG).
- **Shadow and lighting** — a grounding shadow is enabled on both the viewer
  and the mint preview (model-viewer ships `shadow-intensity` at 0), and both
  ask for the `legacy` studio environment rather than the flat `neutral`
  default, so the model shades the same way in the poster and live.
- **A model that never loads** — a header-valid but corrupt GLB reaches the
  preview, never loads, and banks NO poster, so the mint's refusal cannot be
  defeated by a blank-but-valid capture.
- **Feed** — a 3D moment renders its still in the market ovals and no
  `model-viewer` is ever mounted in a feed; on the profile page, which fetches
  its timeline from the browser, a real `MomentCard` grid renders from the
  stubbed data and the card carries the `3D` badge.

## Determinism

Two races were removed after they produced misleading results, and both are
worth knowing about if you extend this file:

- The media input is **server-rendered**, so `setInputFiles` can land before
  hydration and change nothing. That does not fail loudly — it turns "no
  preview mounted" into a *vacuous pass*. Use `pickMedia()`, which retries
  until the app has demonstrably reacted (a preview or a toast).
- A freshly started server compiles a large lazy chunk on the first `/mint`
  request, so the run warms the route before asserting.

Assertions that depend on an element existing are guarded on that fact
explicitly, for the same reason: `document.querySelector(x)?.loaded !== true`
is trivially true when `x` is absent.

## Known gaps

- The homepage hero's `3D` badge is fed by a server-side timeline fetch that
  the browser cannot intercept (seeded, the featured feed never fetches on the
  client). It renders the same `components/ModelBadge` the feed card does, so
  the markup is covered by the profile-grid assertion; only the hero's
  placement is unverified in a browser.
- The edit flow's 3D media replacement (pose, capture, save) needs a creator
  session and an on-chain write, so it is not driven here. Its pieces are the
  mint form's — `ModelPreview`, `ModelPoseBar`, `asGlbFile`, the shared
  `modelMomentFields` builder — each of which this file or `verify:model-media`
  covers; the wiring itself is unverified in a browser. The "optimize for web"
  pass is mint-only (`ModelOptimizeBar` is mounted by `MintForm` alone).
- The collector-file 3D viewer (`components/CollectorFileViewer`) needs a
  holder session, so it is not driven here either. It calls the same
  `configureModelViewerDecoders()` the mint preview proves at the network level
  (section G) and mounts `<model-viewer>` with the same shadow and lighting
  attributes; only its wiring is unverified in a browser.

# HTTP end-to-end check — profile identity (ENS)

`profile-identity.mjs` drives the REAL built app under `next start` against
a stateful mock Upstash and a mock Ethereum-mainnet JSON-RPC it boots itself,
and probes `/api/profiles` and `/api/profile/[address]` over HTTP. No browser.

## Why this is separate from `verify:profile-identity`

That suite pins the `lib/ensCache` state machine and the client cache
contract on the real modules, but — by the verify suite's own rule — never
loads a route handler. The bug it guards against lived in the route wiring:
cold cache misses only ever warmed AFTER the response, so no first view could
show a `.eth` name. This file proves the wiring under the production runtime:
bounded inline resolution, the `after()` continuation on budget overrun and on
a transient RPC failure, and the per-request burst caps.

## Running it

```sh
npm run build
node scripts/e2e/profile-identity.mjs
```

Self-contained: it spawns `next start` on `E2E_PORT` (default 3108) and its
mocks on `E2E_REDIS_PORT` / `E2E_RPC_PORT` (6398 / 8598), and tears all three
down on exit. Exit code is non-zero on any failed check.

## What it asserts (20)

- **P1 cold batch** — the FIRST `/api/profiles` request for a never-seen
  ENS-only address returns the name; it is cached at 24h; a warm re-read
  costs zero RPC calls.
- **P2 cold single** — the FIRST `/api/profile/[address]` view returns
  `displayName`/`ensName`.
- **P3 transient failure** — a 429 degrades the request to no name; the
  after() continuation stores the 30s `!transient` sentinel; requests inside
  the window spend no RPC; after it the same address resolves and displays.
- **P4 budget overrun** — a slow RPC degrades the request; the continuation
  still caches the name; the next request is warm.
- **P5 burst caps** — 20 cold senders resolve at most 8 inline + 8 in the
  background (16 RPC calls), the rest stay cold for a later request.

# Browser end-to-end check — activity panel identity

`activity-identity.mjs` drives a real Chromium against the real built app and
asserts the two client behaviors of `components/MomentActivity` that no other
suite can execute: the one-shot in-view retry that re-resolves senders whose
identity came back unresolved, and the In Process username fallback.
`verify:profile-identity` pins the cache primitive they use
(`invalidateUnresolvedProfiles`), but the wiring lives in a React effect and a
render expression — it needs a browser. `/api/moment`, `/api/moment/comments`
and `/api/profiles` are intercepted in the browser, so every assertion is
about the component, not the upstreams.

## Running it

```sh
npm run build
npm i --no-save playwright@1.56   # not a repo dependency — see above
node scripts/e2e/activity-identity.mjs
```

Self-contained: spawns `scripts/e2e/redis-stub.mjs` and `next start` on
`E2E_PORT` (default 3109), tears both down on exit. `E2E_CHROMIUM` overrides
the browser path. Exit code is non-zero on any failed check.

## What it asserts (10)

- **Cold batch** — one `/api/profiles` request covers every sender; a sender
  with no identity renders the truncated address; senders with an upstream
  username render it instead of the address.
- **One-shot retry** — ~2.5s later, without a reload, the sender whose name
  landed server-side upgrades in-view; a sender that resolved AND had an
  upstream username shows the resolved identity (precedence); a sender still
  unresolved keeps its upstream username; the retry asked exactly for the
  unresolved senders.
- **Exactly once** — no further `/api/profiles` requests after the retry.

# Browser end-to-end check — the sweep

`sweep.ts` drives a real Chromium against the real built app with every
dependency faked in-process: the server's Redis is `_mock-upstash.ts`, the
server's Base RPC is the fake chain of `_sweep-fake-chain.ts` over HTTP, the
browser's RPC traffic to viem's default Base endpoint is intercepted and
answered by the same fake chain, and an EIP-1193 wallet shim is injected into
the page (the Coinbase WebView user agent makes the app auto-connect its
injected provider, so no picker is involved).

## Why this is separate from `verify:sweep`

`verify:sweep` runs the same verification code on the same fake chain, but the
button's placement in the discover header, the sheet's painted states, the
transaction wagmi hands the wallet (with the builder suffix), the receipt
polling and the funnel beacons only exist in a browser.

## Running it

```sh
npm run build
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
  --import ./scripts/register-ts-alias.mjs scripts/e2e/sweep.ts
```

The script drives `playwright-core` (a devDependency, so the gate's typecheck
sees its types on a clean install) and launches the Chromium at `E2E_CHROMIUM`
or, by default, the one Playwright's registry keeps under `/opt/pw-browsers`.
Screenshots land in `.e2e/shots/sweep-*.png`.

## What it asserts (72)

- **Header** — the button renders once `/api/sweep` answers with a pool; at
  375 px the row does not overflow and the stats block wraps under the toggle
  and the button; at 1280 px the stats block sits on the same row, to the
  right.
- **Sheet** — "sweep 10 for <Σ live price + fee>" (the pool carries deliberately
  wrong numbers, so a leak of index values would show); ten rows with a remove
  control, the two reserve rows hidden; a row's live price with the fee
  suffix; remove re-totals to nine; undo is offered.
- **Wallet prompt** — exactly one transaction: to Multicall3, value = Σ of the
  nine, the ERC-8021 suffix appended, and the calldata decodes to
  `aggregate3Value` of nine strict `mint` sub-calls (ids 2–10, quantity 1,
  mintTo = the user, the treasury referral, each value = live price + fee, each
  to its own collection).
- **Done** — "swept 9 artworks" from the receipt, the Basescan link carries the
  hash, "sweep the next 10", nine rows marked swept, undo inert; nine
  `/api/collect` records verified on-chain by the server; `sweep_open`,
  `sweep_attempt`, `sweep_success` each counted once in Redis.
- **Next round** — only the three the wallet does not own (the removed one and
  the two reserve rows); re-opening is not a new `sweep_open`.
- **Needs more ETH** — an empty wallet reads "add ETH, then re-check", the
  footnote counts the rows, the button stays enabled; Escape closes.
- **Flag off** — after the admin POST the header renders no button, and the
  row and stats block carry their original classes (the two-child layout is
  byte-identical to before the feature).
- **Replaced in the wallet** — a cancel replacement (success status, no mint
  in the receipt) is an error, never "swept": no row marked, nothing
  recorded; retry re-verifies and the row is back.
- **Single item** — a lone row is a direct `1155.mint` to the collection with
  the suffix, decodes to `mint(FPSS, 1, 1, [referral], (user, comment))`,
  reaches "swept 1 artwork" and is recorded.
- **Closed mid-flight** — with its receipt held back, Escape closes the sheet
  while it is confirming; reopening reads "retry" with the "still pending"
  toast, offers no basket and sends nothing; once the receipt lands, retry
  re-verifies (the row is owned now) and the in-flight sweep's record still
  arrives.
- **Closed during the prompt** — with the wallet's send held, Escape closes
  the sheet while it is still asking; reopening reads "retry" with the
  "waiting in the wallet" toast, offers no basket and sends nothing; approving
  in the wallet lands the held sweep and its record, and retry then
  re-verifies (the row is owned).
- **Walkthrough regressions** — a dropped row keeps its name visible beside a
  long reason (the reason column wraps), and a success toast after an earlier
  failure carries no stale description.
- No uncaught page errors during the run.

# End-to-end check — the gachapon machines

`scripts/e2e-experience.mjs` (`npm run e2e:experience`) boots the built app
with its Redis, Base RPC, CDP, inprocess and Arweave gateway faked in-process,
then walks both
kinds of machine over real HTTP and, in its second half, in a real Chromium.
CDP credentials are absent, so every delivery lands in `pending` and the
recovery paths run.

## Why this is separate from `verify:experience`

`verify:experience` executes `lib/experience` against a mock Upstash. Route
handlers, request parsing, rate limits, the RPC proofs, the pages, the stage's
timing and the uploads a studio makes only exist in a running app.

## Running it

```sh
NEXT_PUBLIC_ARWEAVE_N=$(node -e "process.stdout.write(Buffer.alloc(512, 7).toString('base64url'))") npm run build
npm run e2e:experience
```

The build needs an Arweave signer key so the studios can upload; any 512-byte
value will do. The server screens every stage frame with `ffmpeg`, as the
runtime image has it, so one must be on PATH — the suite stops and says so
otherwise — and the suite makes its flashing and calm clips with it. The
browser half drives `playwright-core` (skipped, with a
notice, when it is not installed) and the Chromium under `/opt/pw-browsers` (a
failed check when none launches). That Chromium plays VP8 but not H.264, so the
video fixtures are WebM clips the suite records itself. `E2E_SHOTS=<dir>` saves
a full-page screenshot of every page it opens, the stage mid-play, and the
machine share card. About three minutes.

## What it asserts (560)

- **Play** — a capsule is paid for in one signature; the draw, delivery,
  resume after each way delivery can fail, capsules minted elsewhere, and the
  verifier recomputing a play from the revealed seed. A reveal pulls for free
  and collects at the piece's own price.
- **Machines** — the studios (disconnected, connected, publish to review), the
  curator's queue, an artist's opt-outs, linked collections, a machine with
  little or nothing left, the Discover play tab, the nav, the bell, profiles,
  and ending a season on-chain; the seed and referral-payout jobs, each run
  recorded for the app's own schedule (lib/backgroundTasks) to wait on.
- **Art** — the required cover, changed live, and always a still: one that
  moves, or an SVG, is refused as it is picked, and a GIF becomes its first
  frame; the stage (idle, dispense, open), its timing, skip and reduced
  motion, with the platform's capsule and with an artist's frames; frame
  limits, including a GIF's own length; uploads decoded as sent.
- **Flashing (WCAG 2.3.1)** — the studio refuses a clip that flashes four
  times a second, an image that moves, and an SVG, before anything uploads;
  the server screens every frame again: one sent straight to the API waits,
  unplayed, while its gateway holds it back, then is refused, and its creator
  is told why; a clip too long and a moving image are refused by the server
  too; a frame sent back unchanged keeps its verdict; a creator's page takes
  up a verdict without a reload. The window is never larger than the 240 px
  it is screened at, on a desktop, a phone, and with enlarged text.
- **Accessibility** — a status line for each step (WCAG 4.1.3); focus to skip,
  then to the result, without scrolling (2.4.3, 2.4.11); "see odds" landing
  below the fixed header; view transitions that start and run, and none under
  reduced motion.
- **Share card** — a machine's Farcaster embed and its card; a card whose cover
  is out of reach draws its text, not a blank; a machine in review shares the
  bare card.

