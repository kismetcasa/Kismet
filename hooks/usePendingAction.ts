'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'

// How long an armed action stays valid. Long enough to pick a wallet and
// approve the connection; short enough that a stale intent can't fire a
// surprise wallet prompt minutes later.
const TTL_MS = 90_000

// Grace between "connect modal closed while still disconnected" and actually
// cancelling. On a successful connect RainbowKit's modal-close and wagmi's
// isConnected flip land in either order — cancelling on the first signal
// would eat the resume when the close arrives first.
const CANCEL_GRACE_MS = 1_000

/**
 * Resume a user action after a connect round-trip. The web collect tap used
 * to be a dead end: useEnsureConnected opens the RainbowKit picker and
 * returns null, so the handler bailed and the user had to find and tap the
 * button again after connecting. RainbowKit's openConnectModal has no
 * promise, so resumption watches wagmi state instead:
 *
 *   arm(fn) → user connects  → fn() fires once (the action re-runs; its own
 *                              ensureConnected now resolves the address)
 *          → user closes the → intent is cancelled silently — no nagging
 *            picker instead
 *
 * Guard rails: single-shot (cleared before firing), TTL-bounded, cleared on
 * unmount, never persisted. Safe to re-run the full handler: the prepare
 * paths re-read sale state on-chain, and the collect hook's re-entrance
 * latch prevents double submission.
 */
export function usePendingAction(): (fn: () => void) => void {
  const { isConnected } = useAccount()
  const { connectModalOpen } = useConnectModal()
  const pendingRef = useRef<{ fn: () => void; expiresAt: number } | null>(null)
  const sawModalOpenRef = useRef(false)
  // Bump to re-run the effect immediately after arming (refs don't re-render).
  const [armNonce, setArmNonce] = useState(0)

  const arm = useCallback((fn: () => void) => {
    pendingRef.current = { fn, expiresAt: Date.now() + TTL_MS }
    sawModalOpenRef.current = false
    setArmNonce((n) => n + 1)
  }, [])

  useEffect(() => {
    const pending = pendingRef.current
    if (!pending) return
    if (Date.now() > pending.expiresAt) {
      pendingRef.current = null
      return
    }
    if (isConnected) {
      // Clear BEFORE firing — single-shot even if fn re-arms.
      pendingRef.current = null
      pending.fn()
      return
    }
    if (connectModalOpen) {
      sawModalOpenRef.current = true
      return
    }
    if (sawModalOpenRef.current) {
      // Modal closed while still disconnected: either the user changed their
      // mind, or the connect succeeded and isConnected hasn't flipped yet.
      // Cancel after a grace window; a connect arriving inside it re-runs
      // this effect, clears the timer, and fires the action above.
      const timer = setTimeout(() => {
        pendingRef.current = null
      }, CANCEL_GRACE_MS)
      return () => clearTimeout(timer)
    }
  }, [isConnected, connectModalOpen, armNonce])

  // Never let an intent outlive the surface that armed it.
  useEffect(() => () => {
    pendingRef.current = null
  }, [])

  return arm
}
