'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useAccount, useAccountEffect } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'

// How long an armed action stays valid. Long enough to pick a wallet and
// approve the connection; short enough that a stale intent can't fire a
// surprise wallet prompt minutes later.
const TTL_MS = 90_000

interface PendingIntent {
  /** Identity of the hook instance that armed it — unmount clears only its own. */
  owner: symbol
  fn: () => void
  expiresAt: number
}

// MODULE-LEVEL single slot, deliberately shared across every hook instance:
// each feed card owns its own usePendingAction, but a user has exactly ONE
// most-recent intent. Arming replaces any prior intent (last tap wins), and
// the consumer nulls the slot BEFORE firing — so one connect resumes exactly
// one action no matter how many cards armed while disconnected. (A per-
// instance slot let N cards each fire a collect off a single connect —
// stacked wallet prompts for purchases the user thought had failed.)
let pendingIntent: PendingIntent | null = null

/** Consume-and-fire, exactly once. Every instance's onConnect calls this;
 *  the first one in nulls the slot, the rest see null and no-op. */
function firePendingIntent(): void {
  const p = pendingIntent
  pendingIntent = null
  if (p && Date.now() < p.expiresAt) p.fn()
}

/**
 * Resume a user action after a connect round-trip. The web collect tap used
 * to be a dead end: useEnsureConnected opens the RainbowKit picker and
 * returns null, so the handler bailed and the user had to find and tap the
 * button again after connecting. RainbowKit's openConnectModal has no
 * promise, so resumption rides wagmi's own connect event:
 *
 *   arm(fn) → wallet connects   → fn() fires once (the action re-runs; its
 *                                 ensureConnected now resolves the address)
 *          → picker closed      → intent cancelled immediately — safe with
 *            still disconnected   no grace window, because on a SUCCESSFUL
 *                                 connect wagmi's onConnect callback fires on
 *                                 the connector event itself (the very thing
 *                                 that makes RainbowKit close the modal), so
 *                                 the resume has already consumed the intent
 *                                 by the time the close is observed.
 *
 * Guard rails: one module-wide intent (last arm wins, consumed-before-fire =
 * exactly once across all instances), TTL-bounded, cleared on unmount of the
 * arming instance, never persisted. Re-running the handler is safe: the
 * prepare paths re-read sale state on-chain and the collect hook's
 * re-entrance latch prevents double submission.
 */
export function usePendingAction(): (fn: () => void) => void {
  const { isConnected } = useAccount()
  const { connectModalOpen } = useConnectModal()
  const owner = useRef<symbol | null>(null)
  if (owner.current === null) owner.current = Symbol('pending-action-owner')
  const sawModalOpenRef = useRef(false)

  const arm = useCallback((fn: () => void) => {
    pendingIntent = { owner: owner.current!, fn, expiresAt: Date.now() + TTL_MS }
    sawModalOpenRef.current = false
  }, [])

  // Fires on the wagmi connector event (fresh connects AND completed
  // auto-reconnects — the miniapp mid-reconnect arm must resume on either).
  useAccountEffect({
    onConnect() {
      firePendingIntent()
    },
  })

  // Decisive cancel: the picker was open and is now closed while still
  // disconnected → the user changed their mind. No timer, no grace window
  // (see the doc comment for why the successful-connect ordering makes this
  // race-free) — which also closes the resurrection hole where a cleared
  // grace timer let an abandoned intent fire on a later unrelated connect.
  useEffect(() => {
    if (connectModalOpen) {
      sawModalOpenRef.current = true
      return
    }
    if (sawModalOpenRef.current && !isConnected) {
      sawModalOpenRef.current = false
      pendingIntent = null
    }
  }, [connectModalOpen, isConnected])

  // Never let an intent outlive the surface that armed it — but only clear
  // our own (another card may have legitimately re-armed since).
  useEffect(() => {
    const mine = owner.current
    return () => {
      if (pendingIntent?.owner === mine) pendingIntent = null
    }
  }, [])

  return arm
}
