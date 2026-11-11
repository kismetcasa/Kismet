import 'server-only'
import { isSwarmRef, SWARM_PUBLIC_GATEWAY } from './drops'

/**
 * Swarm storage for claim-drop artwork, through the Bee node's HTTP API.
 *
 *   SWARM_BEE_URL      the Bee node Kismet uploads through (Nook's local node
 *                      in development, a Bee container next to the app in
 *                      production). NEVER expose this API publicly: it can
 *                      spend the node's xBZZ and its postage batch.
 *   SWARM_BATCH_ID     the postage batch (prepaid storage rental) uploads are
 *                      stamped with — usable only by the node holding the
 *                      keys and stamperstore it was bought with.
 *   SWARM_GATEWAY_URL  optional gateway for reads when the node is
 *                      unreachable (default: the Swarm Foundation gateway).
 *
 * Plain fetch, not bee-js: two endpoints (POST /bzz, GET /bzz/{ref}/), both
 * checked against Bee's OpenAPI spec (ethersphere/bee openapi/Swarm.yaml).
 *
 * Why Swarm here and Arweave for minted artwork: a drop's image only has to
 * live while the drop is open and settling. Swarm rents storage for a period
 * (the batch's TTL); Arweave sells it forever, up front. A drop that gets
 * claimed is minted through the normal flow, which puts the artwork on
 * Arweave — so permanent storage is only ever paid for artwork people
 * actually claimed.
 */

function beeUrl(): string | null {
  const v = process.env.SWARM_BEE_URL?.trim().replace(/\/+$/, '')
  return v || null
}

function batchId(): string | null {
  const v = process.env.SWARM_BATCH_ID?.trim().toLowerCase().replace(/^0x/, '')
  return v && /^[0-9a-f]{64}$/.test(v) ? v : null
}

function gatewayUrl(): string {
  return (process.env.SWARM_GATEWAY_URL?.trim() || SWARM_PUBLIC_GATEWAY).replace(/\/+$/, '')
}

export function isSwarmUploadConfigured(): boolean {
  return beeUrl() !== null && batchId() !== null
}

/** Public facts the smoke script prints — never the node URL. */
export function swarmPublicInfo(): { batchId: string | null; gateway: string } {
  return { batchId: batchId(), gateway: gatewayUrl() }
}

/**
 * Upload one file. Bee defers uploads unless told otherwise ("Default:
 * deferred (true)"); `swarm-deferred-upload: false` sends the chunks to the
 * network before answering, so the file is readable from any node or gateway
 * as soon as this resolves — not left on a laptop node that may go to sleep.
 * `swarm-pin` also keeps it on our node, where pinned content "will persist
 * even when Bee's garbage collection routine is deleting old chunks", so our
 * node serves it first and fastest.
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
    // A bound, not a measurement: direct upload of up to 15 MB from a light node.
    signal: AbortSignal.timeout(120_000),
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
 * Fetch a file by reference: our node first (pinned), then the gateway. The
 * public gateway answers `/bzz/<ref>/` with 200 and no redirect (checked
 * 2026-11-06), so a redirect here is refused rather than followed. Only the
 * reference is caller-controlled and it is validated as 64 hex characters, so
 * neither URL can be steered anywhere else.
 */
export async function fetchFromSwarm(reference: string): Promise<Response | null> {
  if (!isSwarmRef(reference)) return null
  for (const base of [beeUrl(), gatewayUrl()]) {
    if (!base) continue
    try {
      const res = await fetch(`${base}/bzz/${reference}/`, {
        signal: AbortSignal.timeout(20_000),
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

/** The batch's health from the node (`GET /stamps/{batch_id}`): `usable` means
 *  the node has seen it confirmed on chain; `batchTTL` is seconds of storage
 *  paid for. */
export async function getStampStatus(): Promise<{ usable: boolean; depth: number; batchTTL: number } | null> {
  const bee = beeUrl()
  const batch = batchId()
  if (!bee || !batch) return null
  try {
    const res = await fetch(`${bee}/stamps/${batch}`, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return null
    const j = (await res.json()) as { usable?: unknown; depth?: unknown; batchTTL?: unknown }
    return { usable: j.usable === true, depth: Number(j.depth ?? 0), batchTTL: Number(j.batchTTL ?? 0) }
  } catch {
    return null
  }
}
