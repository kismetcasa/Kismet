'use client'

import { useState, useEffect, useMemo } from 'react'
import { gatewayUrls } from '@/lib/arweave/gateways'

/**
 * Walk the AR.IO / IPFS gateway pool for `uri` on render error. Resets when
 * `uri` changes; calls `onAllError` once every gateway is exhausted.
 *
 * Shared by MomentImage, MomentImg, MomentVideo — every on-chain media
 * render path uses this same walker for consistent fallback semantics.
 */
export function useFallbackUrl(uri: string, onAllError?: () => void) {
  const urls = useMemo(() => gatewayUrls(uri), [uri])
  const [index, setIndex] = useState(0)
  useEffect(() => { setIndex(0) }, [uri])
  return {
    url: index < urls.length ? urls[index] : null,
    onError: () => {
      const next = index + 1
      if (next >= urls.length) onAllError?.()
      setIndex(next)
    },
  }
}

export function isProxiable(uri: string): boolean {
  return uri.startsWith('ar://') || uri.startsWith('ipfs://')
}

export function proxyUrl(uri: string): string {
  return `/api/img?u=${encodeURIComponent(uri)}`
}
