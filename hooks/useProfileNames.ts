'use client'

import { useEffect, useRef, useState } from 'react'
import { shortAddress } from '@/lib/inprocess'
import { fetchCreatorProfilesBatch, invalidateUnresolvedProfiles } from '@/lib/profileCache'

/** Delay before the one-shot re-resolve of addresses that came back with no
 *  name, as MomentActivity does: long enough for the profiles route's bounded
 *  ENS resolution and background warms to land, short enough to be seen. */
const RETRY_DELAY_MS = 2_500

/**
 * The names to show for a set of addresses, by the platform's one standard:
 * Kismet username, then Farcaster username, then ENS (the server's
 * pickProfileIdentity, through /api/profiles), and the short address until
 * one resolves. Batched through the shared profile cache, so a list of many
 * addresses is one request, and retried once for names that land late.
 */
export function useProfileNames(addresses: readonly (string | null | undefined)[]): (address: string) => string {
  const [names, setNames] = useState<Record<string, string>>({})
  const retried = useRef(new Set<string>())
  const key = [...new Set(addresses.filter((a): a is string => !!a).map((a) => a.toLowerCase()))].sort().join(',')

  useEffect(() => {
    if (!key) return
    const list = key.split(',')
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const apply = (profiles: Record<string, { name: string }>) => {
      if (cancelled) return
      setNames((prev) => {
        const next = { ...prev }
        for (const [a, p] of Object.entries(profiles)) next[a] = p.name
        return next
      })
    }
    fetchCreatorProfilesBatch(list).then((profiles) => {
      apply(profiles)
      const late = list.filter((a) => !profiles[a]?.resolved && !retried.current.has(a))
      if (late.length === 0) return
      timer = setTimeout(() => {
        if (cancelled) return
        for (const a of late) retried.current.add(a)
        invalidateUnresolvedProfiles(late)
        fetchCreatorProfilesBatch(late).then(apply)
      }, RETRY_DELAY_MS)
    })
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [key])

  return (address: string) => names[address.toLowerCase()] ?? shortAddress(address)
}
