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

## What it asserts (40)

- **Mint** — the preview is square (not model-viewer's 150px `:host` default),
  a real GLB loads, `toBlob` yields a square JPEG large enough for the 800×800
  OG hero, posing changes what would be captured, the pose hint is visible.
- **Gate** — a zip, a truncated GLB and a glTF 1.0 binary are each rejected
  with the right copy and leave no preview mounted.
- **Detail** — the still paints first, no WebGL exists before the tap, tapping
  mounts exactly one viewer, the still fades only after the model paints,
  exiting unmounts the viewer and restores the affordance.
- **Reduced motion** — `auto-rotate` is off under `prefers-reduced-motion` and
  on without it.
- **Slow load** — the progress readout appears and the still stays visible
  throughout, so a big model on a slow link never shows an empty box.
- **Backdrop** — the preview renders on the artist's colour, switching it
  changes the render, the swatches meet the 24px target-size minimum, and
  model-viewer's own JPEG is black while its PNG keeps alpha (the reason the
  capture composites itself rather than asking for a JPEG).
- **A model that never loads** — a header-valid but corrupt GLB reaches the
  preview, never loads, and banks NO poster, so the mint's refusal cannot be
  defeated by a blank-but-valid capture.
- **Feed** — a 3D moment renders its still, and no `model-viewer` is ever
  mounted in a feed.

## Known gap

`MomentCard`'s `3D` badge is not covered: every page that renders that
component needs SSR data or on-chain reads that cannot be stubbed from the
browser. Its condition (`media.kind === 'model'`) is pinned by
`verify:model-media`; the markup itself is unverified in a browser.
