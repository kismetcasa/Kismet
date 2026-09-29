/**
 * Where `<model-viewer>` fetches its Draco and KTX2 decoders from — set the
 * way the library actually reads it.
 *
 * model-viewer's element CONSTRUCTOR re-reads the decoder locations from the
 * global config object `self.ModelViewerElement` every time an element is
 * created, falling back to www.gstatic.com when the global has no entry
 * (@google/model-viewer 4.3.1, features/loading.js: the LoadingMixin
 * constructor runs `CachingGLTFLoader.setDRACODecoderLocation(
 * (self.ModelViewerElement || {}).dracoDecoderLocation || DEFAULT)`). The
 * static setter on the imported class — `ModelViewerElement.dracoDecoderLocation
 * = …`, which this codebase used — updates the loader only until the next
 * element is constructed, and the ESM build never assigns the global. So the
 * self-hosted decoders in public/model-decoders/ were never what a Draco
 * model actually loaded: every viewer silently fetched gstatic's copy, which
 * the CSP work assumed was gone. Caught by the browser E2E when the mint
 * form's "optimize for web" produced the first Draco model in a sandbox with
 * no egress (GLB_3D_VIEWER_DESIGN.md, finding 28).
 *
 * Call before the first element is created — idempotent, cheap, and safe to
 * repeat at every mount site.
 */

export const DRACO_DECODER_LOCATION = '/model-decoders/draco/'
export const KTX2_TRANSCODER_LOCATION = '/model-decoders/basis/'

interface ModelViewerGlobalConfig {
  dracoDecoderLocation?: string
  ktx2TranscoderLocation?: string
}

export function configureModelViewerDecoders(): void {
  if (typeof self === 'undefined') return
  const scope = self as unknown as { ModelViewerElement?: ModelViewerGlobalConfig }
  const config = (scope.ModelViewerElement ??= {})
  config.dracoDecoderLocation = DRACO_DECODER_LOCATION
  config.ktx2TranscoderLocation = KTX2_TRANSCODER_LOCATION
}
