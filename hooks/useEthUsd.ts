'use client'

import { useEffect, useState } from 'react'

// ETH→USD rate for live conversion labels (mint form's "≈ $…" line). Fetches
// once on mount, then refreshes every 60s — matching /api/eth-usd's cache
// window, so polling faster would only re-read the same Chainlink answer.
// Returns null until the first fetch resolves or when the feed is down/stale;
// callers hide their USD line in that case rather than showing a wrong
// number. A refresh failure keeps the last known rate — one blip shouldn't
// blank a label the artist is actively reading.
export function useEthUsd(): number | null {
  const [ethUsd, setEthUsd] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/eth-usd')
        if (!res.ok) return
        const data = (await res.json()) as { ethUsd?: number | null }
        if (!cancelled && typeof data.ethUsd === 'number' && data.ethUsd > 0) {
          setEthUsd(data.ethUsd)
        }
      } catch {
        // keep last known rate
      }
    }
    void load()
    const id = setInterval(() => void load(), 60_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  return ethUsd
}
