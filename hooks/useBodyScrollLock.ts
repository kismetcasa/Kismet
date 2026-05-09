'use client'

import { useEffect } from 'react'

export function useBodyScrollLock(enabled = true): void {
  useEffect(() => {
    if (!enabled) return
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [enabled])
}
