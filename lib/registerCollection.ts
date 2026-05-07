/**
 * Client-side registration of a freshly-deployed Zora 1155 collection
 * with our KV. Hits `POST /api/collections`, which verifies on-chain
 * admin before accepting the entry.
 *
 * Both deploy paths (explicit factory call and auto-deploy via
 * `/api/moment/create`) call this immediately after the contract
 * exists on chain. The verification can race two propagation lags:
 * the Base RPC's view of the chain head, and Upstash's eventual
 * consistency. Retry-with-backoff covers both. Stable-cause failures
 * (401 missing session, 403 wrong artist) bail immediately since they
 * won't recover on retry.
 *
 * Logs failures to console — fire-and-forget; the collection is real
 * on chain regardless of whether the KV write lands. Caller surfaces
 * the success state independently.
 */
export interface RegisterCollectionPayload {
  address: string
  name: string
  description?: string
  image?: string
  artist?: string
}

export async function registerCollectionWithBackoff(
  payload: RegisterCollectionPayload,
): Promise<void> {
  const delays = [0, 1000, 2500, 5000]
  let lastDetail: string | null = null
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]))
    try {
      const res = await fetch('/api/collections', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.ok) return
      const text = await res.text().catch(() => '')
      lastDetail = `${res.status} ${text.slice(0, 200)}`
      // 401/403 won't recover on retry; everything else (502 admin-check
      // race, 429 rate limit) might.
      if (res.status === 401 || res.status === 403) break
    } catch (err) {
      lastDetail = err instanceof Error ? err.message : String(err)
    }
  }
  console.error('[registerCollection] /api/collections registration failed', {
    address: payload.address,
    detail: lastDetail,
  })
}
