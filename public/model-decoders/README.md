# Self-hosted glTF decoders

`<model-viewer>` fetches its Draco geometry decoder and KTX2/Basis texture
transcoder **at runtime**. Its defaults point at
`https://www.gstatic.com/draco/versioned/decoders/…` and
`https://www.gstatic.com/basis-universal/versioned/…` — an undeclared
third-party origin on a path that is otherwise entirely self-hosted, and one
that would break the moment the Content-Security-Policy in `next.config.mjs`
is promoted from Report-Only to enforcing (it self-documents that promotion
as "step 1 of 2").

Draco compression is the standard optimization for web-delivered GLBs, so
this is a routine path, not an edge case: without these files a Draco model
silently fails to render.

`components/CollectorFileViewer.tsx` points model-viewer here instead.

## Provenance / how to refresh

Copied verbatim from the `three` package (a model-viewer dependency), so the
decoder always matches the three.js build that loads it:

    cp node_modules/three/examples/jsm/libs/draco/gltf/{draco_decoder.js,draco_decoder.wasm,draco_wasm_wrapper.js} public/model-decoders/draco/
    cp node_modules/three/examples/jsm/libs/basis/{basis_transcoder.js,basis_transcoder.wasm} public/model-decoders/basis/

Re-run after any `@google/model-viewer` / `three` upgrade. These are static
assets served on demand — they add nothing to any JS bundle.
