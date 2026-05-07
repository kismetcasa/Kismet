'use client'

import { useEffect, useState } from 'react'
import { resolveUri } from './inprocess'

// Module-level cache so a writing moment's body fetched in the feed card is
// reused by the modal and detail page without refetching. Keyed by the raw
// content uri (e.g. ar://…) so callers don't need to resolve before lookup.
const cache = new Map<string, string>()

export async function fetchTextContent(uri: string): Promise<string> {
  const cached = cache.get(uri)
  if (cached !== undefined) return cached
  const res = await fetch(resolveUri(uri))
  if (!res.ok) throw new Error(`text fetch ${res.status}`)
  const text = await res.text()
  cache.set(uri, text)
  return text
}

/** React hook wrapper. Returns null until the body resolves; never throws.
 *  Pass initialValue to hydrate from a server-prefetched string instantly. */
export function useTextContent(uri: string | undefined, initialValue?: string): string | null {
  const [text, setText] = useState<string | null>(() => {
    if (!uri) return null
    if (initialValue !== undefined) {
      cache.set(uri, initialValue)
      return initialValue
    }
    return cache.get(uri) ?? null
  })
  useEffect(() => {
    if (!uri) return
    if (cache.has(uri)) {
      setText(cache.get(uri) ?? null)
      return
    }
    let cancelled = false
    fetchTextContent(uri)
      .then((t) => {
        if (!cancelled) setText(t)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [uri])
  return text
}
