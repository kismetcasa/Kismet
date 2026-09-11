# Browser end-to-end check — 3D moments

`model-media.mjs` drives a real Chromium against a real build and asserts the
parts of the GLB feature that only exist on screen.

## Why this is separate from `npm run check`

The 150px-strip bug (GLB_3D_VIEWER_DESIGN.md, finding 15) passed typecheck,
lint, the 44-assertion `verify:model-media` oracle **and** the bundle guard.
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
npx next start -p 3100 &

# 3. Fixtures: a spec-valid glTF 2.0 cube plus a still.
mkdir -p .e2e && node scripts/e2e/make-glb.mjs .e2e/cube.glb
node -e "require('sharp')({create:{width:600,height:600,channels:3,background:{r:20,g:120,b:90}}}).jpeg().toFile('.e2e/poster.jpg')"

# 4. The check. Screenshots land in .e2e/shots/.
npx playwright@1.56 install-deps 2>/dev/null || true
node scripts/e2e/model-media.mjs
```

`playwright` is intentionally NOT a repo dependency — install it ad hoc
(`npm i --no-save playwright`) or point `E2E_CHROMIUM` at a browser you have.
`E2E_BASE_URL` and `E2E_DIR` override the server and fixture locations.

## What it asserts (49)

- **Mint** — the preview is square (not model-viewer's 150px `:host` default),
  a real GLB loads, `toBlob` yields a square JPEG large enough for the 800×800
  OG hero (deterministic: the preview pins the renderer's dynamic scale to 1
  while mounted — under CPU load it otherwise halves, and this suite caught a
  755px capture that way), posing changes what would be captured, the pose
  hint is visible.
- **Gate** — a zip, a truncated GLB and a glTF 1.0 binary are each rejected
  with the right copy and leave no preview mounted.
- **Detail** — the still paints first, no WebGL exists before the tap, tapping
  mounts exactly one viewer, the still fades only after the model paints,
  exiting unmounts the viewer and restores the affordance.
- **Reduced motion** — `auto-rotate` is off under `prefers-reduced-motion` and
  on without it.
- **Slow load** — the progress readout appears and the still stays visible
  throughout, so a big model on a slow link never shows an empty box.
- **Backdrop** — all three options are offered, the preview renders on the
  artist's colour, switching it changes the render, the swatches meet the
  24px target-size minimum, `transparent` lets the page through the viewer
  while the thumbnail stays opaque, and model-viewer's own JPEG is black
  while its PNG keeps alpha (the reason the capture composites itself rather
  than asking for a JPEG).
- **Shadow** — a grounding shadow is enabled on both the viewer and the mint
  preview; model-viewer ships `shadow-intensity` at 0.
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
  covers; the wiring itself is unverified in a browser.

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
