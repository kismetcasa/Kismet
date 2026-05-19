'use client'

import { useState, useEffect } from 'react'

// Flips to true after the first client render commits. Use to gate
// localStorage reads (and any render that depends on them) without
// causing a hydration mismatch with the SSR HTML.
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => { setHydrated(true) }, [])
  return hydrated
}
