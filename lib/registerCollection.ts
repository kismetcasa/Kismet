/**
 * Client-side registration helper for a freshly-deployed collection.
 *
 * Both deploy paths (CreateCollectionForm's explicit factory deploy and
 * MintForm's Phase 2 auto-deploy via /api/moment/create) must hit
 * /api/collections POST after the contract exists on chain — that's
 * what makes the collection appear in the user's profile + the picker
 * dropdown. The endpoint runs an on-chain admin verification before
 * accepting the registration, which is race-prone in two ways:
 *
 *   1. The on-chain admin check reads via the configured Base RPC,
 *      which can lag the chain head by a few seconds after a fresh
 *      deploy (especially on the public endpoint). A read at attempt
 *      0 may see permissions=0; the same read 2s later sees the
 *      defaultAdmin grant from the deploy block.
 *
 *   2. Upstash can briefly hiccup under contention.
 *
 * Retrying with backoff (0/1s/2.5s/5s) covers both. Stable-cause
 * failures (401 missing session, 403 wrong artist) bail immediately
 * since they won't recover on retry; 502/429 retry through the full
 * schedule.
 *
 * Logs failures to console so a missed registration is visible in
 * devtools instead of silently producing a "deployed!" toast for a
 * collection that never enters our KV. Designed to be fire-and-
 * forget — never throws, so the caller's success state isn't undone
 * by a transient KV outage. The collection is real on chain either way.
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
      // 401/403 with stable causes (bad session, wrong artist) won't fix on
      // retry; 502 (admin-check RPC) and 429 will. 502 is the propagation
      // race we expect post-deploy.
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
