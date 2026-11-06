import 'server-only'
import { isSwarmRef } from './drops'

/**
 * Swarm storage for claim-drop artwork, through the Bee node's HTTP API.
 *
 *   SWARM_BEE_URL      the Bee node Kismet uploads through (Nook's local node
 *                      in development, a Bee container next to the app in
 *                      production). NEVER expose this API publicly: it can
 *                      spend the node's xBZZ and its postage batch.
 *   SWARM_BATCH_ID     the postage batch (prepaid storage rental) uploads are
 *                      stamped with — owned by that node's wallet.
 *   SWARM_GATEWAY_URL  optional public gateway for reads when the node is
 *                      unreachable (default: the Swarm Foundation gateway).
 *
 * Why plain fetch instead of bee-js: two endpoints (POST /bzz, GET
 * /bzz/{ref}/) — no SDK surface to justify the dependency.
 *
 * Why Swarm here and Arweave for minted artwork: a drop's image only has to
 * live while the drop is open and settling. Swarm rents storage for a period
 * (the batch's TTL); Arweave sells it forever, up front. A drop that gets
 * claimed is minted through the normal flow, which puts the artwork on
 * Arweave — so permanent storage is only ever paid for artwork people
 * actually claimed.
 */

const DEFAULT_GATEWAY = 'https://api.gateway.ethswarm.org'
const UPLOAD_TIMEOUT_MS = 120_000
const READ_TIMEOUT_MS = 20_000

function beeUrl(): string | null {
  const v = process.env.SWARM_BEE_URL?.trim().replace(/\/+$/, '')
  return v || null
}

function batchId(): string | null {
  const v = process.env.SWARM_BATCH_ID?.trim().toLowerCase().replace(/^0x/, '')
  return v && /^[0-9a-f]{64}$/.test(v) ? v : null
}

function gatewayUrl(): string {
  return (process.env.SWARM_GATEWAY_URL?.trim() || DEFAULT_GATEWAY).replace(/\/+$/, '')
}

export function isSwarmUploadConfigured(): boolean {
  return beeUrl() !== null && batchId() !== null
}

/** Public facts for docs and the admin view — never the node URL. */
export function swarmPublicInfo(): { batchId: string | null; gateway: string } {
  return { batchId: batchId(), gateway: gatewayUrl() }
}

/**
 * Upload one file. `swarm-deferred-upload: false` makes Bee push every chunk
 * to the network before answering, so the file is readable from any node or
 * gateway the moment this resolves (a deferred upload can sit on a laptop's
 * node and vanish when it sleeps). `swarm-pin` also keeps a local copy on
 * our node, which serves reads fastest.
 */
export async function uploadToSwarm(bytes: Uint8Array, mime: string, name: string): Promise<{ reference: string }> {
  const bee = beeUrl()
  const batch = batchId()
  if (!bee || !batch) throw new Error('Swarm upload is not configured (SWARM_BEE_URL, SWARM_BATCH_ID)')

  const res = await fetch(`${bee}/bzz?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      'content-type': mime,
      'swarm-postage-batch-id': batch,
      'swarm-deferred-upload': 'false',
      'swarm-pin': 'true',
    },
    body: bytes as BodyInit,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Bee upload failed: ${res.status} ${detail.slice(0, 300)}`)
  }
  const json = (await res.json()) as { reference?: unknown }
  const reference = typeof json.reference === 'string' ? json.reference.toLowerCase() : ''
  if (!isSwarmRef(reference)) throw new Error('Bee upload returned no reference')
  return { reference }
}

/**
 * Fetch a file by reference: our node first (fast, pinned), then the public
 * gateway. Only the reference is caller-controlled and it is validated as 64
 * hex characters, so neither URL can be steered anywhere else.
 */
export async function fetchFromSwarm(reference: string): Promise<Response | null> {
  if (!isSwarmRef(reference)) return null
  const bases = [beeUrl(), gatewayUrl()].filter((b): b is string => !!b)
  for (const base of bases) {
    try {
      const res = await fetch(`${base}/bzz/${reference}/`, {
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        redirect: 'error',
      })
      if (res.ok && res.body) return res
      await res.body?.cancel().catch(() => {})
    } catch {
      // try the next source
    }
  }
  return null
}

export interface StampStatus {
  usable: boolean
  utilization: number
  depth: number
  /** Seconds of storage the batch has paid for. */
  batchTTL: number
}

/** The batch's health, from the node — for the admin view and the smoke test. */
export async function getStampStatus(): Promise<StampStatus | null> {
  const bee = beeUrl()
  const batch = batchId()
  if (!bee || !batch) return null
  try {
    const res = await fetch(`${bee}/stamps/${batch}`, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) })
    if (!res.ok) return null
    const j = (await res.json()) as Partial<StampStatus>
    return {
      usable: j.usable === true,
      utilization: Number(j.utilization ?? 0),
      depth: Number(j.depth ?? 0),
      batchTTL: Number(j.batchTTL ?? 0),
    }
  } catch {
    return null
  }
}
