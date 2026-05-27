'use client'

import { useEffect, useState } from 'react'

// Reads the platform-pause flag for client-side UI affordances (e.g.
// disabling the create-collection button). Fails open: a fetch error
// leaves `paused` false so a flaky status read never blocks the user,
// matching the server's fail-open pause behavior (getGateConfig returns
// paused:false when Redis is unreachable).
export function usePlatformPaused(): { paused: boolean; loading: boolean } {
  const [paused, setPaused] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/platform-status')
        if (!res.ok) return
        const data = (await res.json()) as { paused?: boolean }
        if (!cancelled) setPaused(data.paused === true)
      } catch {
        // fail open — leave paused false
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return { paused, loading }
}
