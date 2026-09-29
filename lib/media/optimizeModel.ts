import { GLB_MIME, isWellFormedGlbHeader } from '../glbFormat.ts'

/**
 * "Optimize for web" for a picked GLB — the mint form's optional pass before
 * a model is uploaded for good (GLB_3D_VIEWER_DESIGN.md, "The artist's
 * fourth round"). Browser-only: it draws on a canvas and loads the Draco
 * encoder by script tag. Always reached through a dynamic import, so
 * glTF-Transform and the encoder cost nothing until the artist clicks.
 *
 * What it does, in the order that keeps each step cheap:
 *   1. TEXTURES — the bulk of most real models. Any raster texture whose
 *      longest edge exceeds OPTIMIZE_MAX_TEXTURE_PX is downscaled to fit,
 *      re-encoded in its own format (PNG stays lossless, JPEG at 0.9) and
 *      kept only if the result is smaller. The Khronos real-time asset
 *      guidelines put textures at 1K–2K; an 8K albedo is print resolution.
 *   2. GEOMETRY — glTF-Transform's `dedup` and `prune` drop duplicated
 *      accessors and unreferenced nodes/materials, then Draco compresses
 *      the meshes. Draco rather than meshopt because meshopt is designed to
 *      be gzipped in transit and neither arweave.net nor our proxy promise
 *      that for `model/gltf-binary`, while Draco is self-contained — and its
 *      decoder is what the viewer already self-hosts.
 *   3. A header check on the output, and a size check: if the result is not
 *      smaller, the artist keeps their original and is told so.
 *
 * What it will not touch: a model already compressed with meshopt (we ship
 * no meshopt decoder, so it cannot even be read here), KTX2/Basis textures
 * (already GPU-compressed; not a canvas format), and primitives Draco
 * cannot encode (points, lines, morph targets) — those keep their geometry
 * and the rest of the pass still applies.
 */

/** Longest texture edge kept. 2K, per the Khronos guidelines. */
export const OPTIMIZE_MAX_TEXTURE_PX = 2048

export type OptimizeStep = 'reading' | 'textures' | 'geometry' | 'writing'

export interface OptimizeResult {
  file: File
  before: number
  after: number
  /** What changed, for the toast. Empty when `unchanged`. */
  applied: string[]
  /** No smaller file could be produced: `file` is the untouched input. */
  unchanged: boolean
}

const DRACO_DIR = '/model-decoders/draco/'
const JSON_CHUNK = 0x4e4f534a

type EmscriptenFactory = (config: {
  wasmBinary: ArrayBuffer
  onModuleLoaded: (module: unknown) => void
}) => unknown

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`)
    if (existing?.dataset.loaded === '1') return resolve()
    const script = existing ?? document.createElement('script')
    script.addEventListener('load', () => {
      script.dataset.loaded = '1'
      resolve()
    })
    script.addEventListener('error', () => {
      // Drop the failed tag so a retry can create a fresh one instead of
      // waiting on an element that will never fire `load`.
      script.remove()
      reject(new Error(`Could not load ${src}`))
    })
    if (!existing) {
      script.src = src
      script.async = true
      document.head.appendChild(script)
    }
  })
}

/**
 * Load an Emscripten module the way three's DRACOLoader does: the wrapper
 * script defines a global factory, we fetch the wasm ourselves and hand it
 * over as `wasmBinary` so the wrapper never has to locate a file, and the
 * module arrives through `onModuleLoaded` (the callback three uses; Draco
 * 1.5.7's wrapper also returns a promise, but one path is enough). Memoized:
 * the encoder is ~420 KB and one page load needs it at most once.
 */
const modules = new Map<string, Promise<unknown>>()
function loadDracoModule(global: 'DracoEncoderModule' | 'DracoDecoderModule', wrapper: string, wasm: string): Promise<unknown> {
  let pending = modules.get(global)
  if (!pending) {
    pending = (async () => {
      const [, wasmBinary] = await Promise.all([
        loadScript(`${DRACO_DIR}${wrapper}`),
        fetch(`${DRACO_DIR}${wasm}`).then((r) => {
          if (!r.ok) throw new Error(`Could not load ${wasm}`)
          return r.arrayBuffer()
        }),
      ])
      const factory = (globalThis as unknown as Record<string, EmscriptenFactory | undefined>)[global]
      if (typeof factory !== 'function') throw new Error(`${global} did not define itself`)
      return new Promise<unknown>((resolve) => factory({ wasmBinary, onModuleLoaded: resolve }))
    })().catch((err) => {
      modules.delete(global)
      throw err
    })
    modules.set(global, pending)
  }
  return pending
}

/** The extensions a GLB declares, read from its JSON chunk without a full
 *  parse — cheap, and it decides which decoders are worth loading. Exported
 *  for verify:model-media, which pins the chunk offsets. */
export function declaredExtensions(bytes: Uint8Array): Set<string> {
  const out = new Set<string>()
  if (bytes.length < 20) return out
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const length = view.getUint32(12, true)
  if (view.getUint32(16, true) !== JSON_CHUNK || 20 + length > bytes.length) return out
  try {
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length))) as {
      extensionsUsed?: string[]
      extensionsRequired?: string[]
    }
    for (const name of [...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])]) out.add(name)
  } catch {
    // Not our problem to diagnose here — glTF-Transform's reader will say.
  }
  return out
}

/** Downscale a raster texture to fit `maxPx`, in its own format. Null when
 *  it already fits, is not a canvas-decodable format, or would not shrink. */
async function shrinkTexture(image: Uint8Array, mime: string, maxPx: number): Promise<Uint8Array | null> {
  if (!/^image\/(png|jpeg|webp)$/.test(mime)) return null
  const bitmap = await createImageBitmap(new Blob([image as BlobPart], { type: mime }))
  try {
    const scale = maxPx / Math.max(bitmap.width, bitmap.height)
    if (scale >= 1) return null
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, mime, mime === 'image/png' ? undefined : 0.9),
    )
    if (!blob) return null
    const out = new Uint8Array(await blob.arrayBuffer())
    return out.length < image.length ? out : null
  } finally {
    bitmap.close()
  }
}

export async function optimizeGlb(
  input: File,
  opts: { onStep?: (step: OptimizeStep) => void } = {},
): Promise<OptimizeResult> {
  const step = (s: OptimizeStep) => opts.onStep?.(s)

  step('reading')
  const bytes = new Uint8Array(await input.arrayBuffer())
  const declared = declaredExtensions(bytes)
  if (declared.has('EXT_meshopt_compression')) {
    throw new Error('This model is already compressed with meshopt — nothing more to do here.')
  }
  const [{ WebIO }, { ALL_EXTENSIONS }, { dedup, draco, prune }] = await Promise.all([
    import('@gltf-transform/core'),
    import('@gltf-transform/extensions'),
    import('@gltf-transform/functions'),
  ])
  // Writing a Draco document re-encodes its meshes, so the encoder is needed
  // whether the input was compressed already or not; the decoder only when
  // it was.
  const alreadyDraco = declared.has('KHR_draco_mesh_compression')
  const [encoder, decoder] = await Promise.all([
    loadDracoModule('DracoEncoderModule', 'draco_encoder_wrapper.js', 'draco_encoder.wasm'),
    alreadyDraco
      ? loadDracoModule('DracoDecoderModule', 'draco_wasm_wrapper.js', 'draco_decoder.wasm')
      : Promise.resolve(null),
  ])
  const io = new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.encoder': encoder,
    ...(decoder ? { 'draco3d.decoder': decoder } : {}),
  })
  const doc = await io.readBinary(bytes)
  const applied: string[] = []

  step('textures')
  let shrunk = 0
  for (const texture of doc.getRoot().listTextures()) {
    const image = texture.getImage()
    if (!image) continue
    const smaller = await shrinkTexture(image, texture.getMimeType(), OPTIMIZE_MAX_TEXTURE_PX)
    if (smaller) {
      texture.setImage(smaller)
      shrunk++
    }
  }
  if (shrunk > 0) applied.push(`${shrunk} texture${shrunk === 1 ? '' : 's'} downscaled to ${OPTIMIZE_MAX_TEXTURE_PX}px`)

  step('geometry')
  await doc.transform(dedup(), prune())
  if (!alreadyDraco) {
    try {
      await doc.transform(draco({ method: 'edgebreaker', encodeSpeed: 5, decodeSpeed: 5 }))
      applied.push('Draco geometry compression')
    } catch {
      // Geometry Draco cannot encode (points, lines, morph targets) keeps
      // its original accessors; the texture and cleanup steps still count.
    }
  }

  step('writing')
  const out = await io.writeBinary(doc)
  if (!isWellFormedGlbHeader(out.subarray(0, 12), out.length)) {
    throw new Error('The optimized model did not export cleanly — keeping the original.')
  }
  if (out.length >= input.size) {
    return { file: input, before: input.size, after: input.size, applied: [], unchanged: true }
  }
  const name = `${input.name.replace(/\.glb$/i, '')}.glb`
  return {
    file: new File([out as BlobPart], name, { type: GLB_MIME, lastModified: Date.now() }),
    before: input.size,
    after: out.length,
    applied,
    unchanged: false,
  }
}
