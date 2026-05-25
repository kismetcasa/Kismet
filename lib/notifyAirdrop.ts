/**
 * Client-side recording of a completed on-chain airdrop with our backend.
 * Hits `POST /api/airdrop/notify`, which verifies the tx on-chain, debits
 * quota, and records the airdrop so it surfaces in the sender's profile and
 * recipient inboxes.
 *
 * The on-chain adminMint has already landed by the time this runs, so the
 * record is the only thing that can still be lost. The endpoint is
 * idempotency-locked and verify-gated, so re-POSTing the same (txHash,
 * collection, tokenId, sender) is a safe no-op — which is exactly what makes
 * retry-with-backoff correct here. A transient 5xx / network blip self-heals
 * instead of silently stranding the airdrop off-chain.
 *
 * Logs failures to console — fire-and-forget; the tokens are minted on chain
 * regardless of whether the record lands.
 */
export interface NotifyAirdropPayload {
  sender: string
  collectionAddress: string
  tokenId: string
  recipients: string[]
  txHash: string
}

export async function notifyAirdropWithBackoff(
  payload: NotifyAirdropPayload,
): Promise<void> {
  const delays = [0, 1000, 2500, 5000]
  let lastDetail: string | null = null
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]))
    try {
      const res = await fetch('/api/airdrop/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) return
      const text = await res.text().catch(() => '')
      lastDetail = `${res.status} ${text.slice(0, 200)}`
      // 4xx is a definitive rejection (bad recipients, blacklist, too many,
      // on-chain verify failed) — won't recover on retry. Only transient 5xx
      // / network errors are worth retrying.
      if (res.status >= 400 && res.status < 500) break
    } catch (err) {
      lastDetail = err instanceof Error ? err.message : String(err)
    }
  }
  console.error('[notifyAirdrop] /api/airdrop/notify recording failed', {
    txHash: payload.txHash,
    detail: lastDetail,
  })
}
