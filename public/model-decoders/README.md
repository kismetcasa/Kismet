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

`components/CollectorFileViewer.tsx`, `components/MomentModel.tsx` and
`components/ModelPreview.tsx` point model-viewer here instead.

The Draco **encoder** (`draco_encoder_wrapper.js` + `draco_encoder.wasm`) is
here too, for the mint form's "optimize for web" pass
(`lib/media/optimizeModel.ts`), which loads it by script tag exactly the way
three's DRACOLoader loads the decoder and hands it the wasm as `wasmBinary`.

## Provenance / how to refresh

Copied verbatim from the `three` package (a model-viewer dependency), so the
decoder always matches the three.js build that loads it:

    cp node_modules/three/examples/jsm/libs/draco/gltf/{draco_decoder.js,draco_decoder.wasm,draco_wasm_wrapper.js} public/model-decoders/draco/
    cp node_modules/three/examples/jsm/libs/basis/{basis_transcoder.js,basis_transcoder.wasm} public/model-decoders/basis/

The encoder pair comes from the Draco release matching the npm package
(`google/draco` tag 1.5.7, `javascript/draco_encoder_wrapper.js` and
`javascript/draco_encoder.wasm`; the wasm is byte-identical to
`draco3d@1.5.7`'s). Refresh it from the same tag whenever the decoder is:

    curl -o public/model-decoders/draco/draco_encoder_wrapper.js https://raw.githubusercontent.com/google/draco/1.5.7/javascript/draco_encoder_wrapper.js
    curl -o public/model-decoders/draco/draco_encoder.wasm https://raw.githubusercontent.com/google/draco/1.5.7/javascript/draco_encoder.wasm

Re-run after any `@google/model-viewer` / `three` upgrade. These are static
assets served on demand — they add nothing to any JS bundle.
