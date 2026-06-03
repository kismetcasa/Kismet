'use client'

import { useCallback, useRef } from 'react'
import { useConfig, useReconnect } from 'wagmi'
import { getAccount } from '@wagmi/core'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { isAuthError, toastError, toastReloadRecovery } from '@/lib/toast'

interface UseWalletRecoveryReturn {
  /** Read-and-clear the post-reconnect retry flag. Call at hook entry. */
  consumeRetryFlag: () => boolean
  /** Render the recovery toast for an error. Layer-3 (Reload) when the retry itself failed auth-class; layer-2 (Reconnect) otherwise. */
  showError: (err: unknown, isRetryAfterRecovery: boolean, retry: () => void) => void
  /** Call from every success path. Marks an in-flight recovery as superseded so its auto-retry doesn't re-dispatch the same write. */
  ackSuccess: () => void
}

/**
 * Progressive recovery for a stale wallet session, shared by every
 * wallet-write hook. Owns the layer-2 (reconnect + retry) and layer-3
 * (reload) recovery flow and the single-shot retry flag that gates
 * between them.
 *
 * Connector behavior on reconnect: Farcaster / injected re-authorizes
 * silently; WalletConnect either re-pairs or actively disconnects (its
 * isAuthorized() tears down stale sessions). When that drops us to
 * disconnected, we open the wallet picker so the user always lands
 * somewhere actionable.
 */
export function useWalletRecovery(toastId: string, action: string): UseWalletRecoveryReturn {
  const config = useConfig()
  const { reconnectAsync } = useReconnect()
  const { openConnectModal } = useConnectModal()
  // RainbowKit recreates openConnectModal's identity on modal-state churn;
  // pin it to a ref so the consumer's useCallback deps stay stable.
  const openConnectModalRef = useRef(openConnectModal)
  openConnectModalRef.current = openConnectModal

  const isRetryAfterRecoveryRef = useRef(false)
  // True between the user tapping Reconnect and the recovery's
  // continuation deciding what to do (retry vs. open modal). Gates the
  // supersede logic — events outside this window don't affect recovery.
  const pendingRecoveryRef = useRef(false)
  // Set during a pending recovery when something happens that should
  // cancel the planned auto-retry: a fresh wallet write succeeded
  // (double-charge avoidance), or a fresh error toast appeared (surprise
  // avoidance — user already saw a new error and would be confused by a
  // delayed auto-prompt).
  const recoverySupersededRef = useRef(false)

  const consumeRetryFlag = useCallback(() => {
    const v = isRetryAfterRecoveryRef.current
    isRetryAfterRecoveryRef.current = false
    return v
  }, [])

  const ackSuccess = useCallback(() => {
    if (pendingRecoveryRef.current) {
      recoverySupersededRef.current = true
    }
  }, [])

  const showError = useCallback(
    (err: unknown, isRetryAfterRecovery: boolean, retry: () => void) => {
      // A fresh error during a pending recovery — not the recovery's own
      // retry — means the user just saw a new toast. Don't auto-prompt
      // them later when the original `reconnectAsync` resolves.
      if (pendingRecoveryRef.current && !isRetryAfterRecovery) {
        recoverySupersededRef.current = true
      }
      // Layer 3: reconnect already ran and the wallet is still unauthorized
      // (most commonly a Mini App with a dead host bridge). Reload is the
      // only fix that works across every connector type.
      if (isRetryAfterRecovery && isAuthError(err)) {
        toastReloadRecovery({ id: toastId })
        return
      }
      // Layer 2: clean error toast with a Reconnect action.
      toastError(action, err, {
        id: toastId,
        onReconnect: () => {
          // Dedupe overlapping Reconnect clicks — when a manual write
          // fails during a recovery's await, the new error toast carries
          // its own Reconnect button. The user might tap it; we already
          // have a recovery in flight, so just let that one finish.
          // (toastError's onClick already set the "Reconnecting…" loading
          // toast, so the user gets visual feedback either way.)
          if (pendingRecoveryRef.current) return
          pendingRecoveryRef.current = true
          recoverySupersededRef.current = false
          void (async () => {
            try {
              // Some connectors throw on reconnect; either way the
              // post-reconnect getAccount check is the source of truth.
              await reconnectAsync().catch(() => {})
              if (recoverySupersededRef.current) {
                toast.dismiss(toastId)
                return
              }
              const account = getAccount(config)
              if (account.status === 'connected' && account.address) {
                isRetryAfterRecoveryRef.current = true
                retry()
              } else {
                // Dismiss the "Reconnecting…" toast before the wallet
                // picker takes over — otherwise it lingers in the corner.
                toast.dismiss(toastId)
                // RainbowKit only exposes `openConnectModal` as a defined
                // function when wagmi.status is 'disconnected'. wagmi just
                // flipped to disconnected via reconnectAsync, but React
                // hasn't yet committed the resulting render — so the ref
                // we captured pre-disconnect is still `undefined`. Defer
                // past the next render via a 0-ms macrotask so React
                // commits the post-disconnect state and the ref points
                // at a real function before we invoke it.
                setTimeout(() => openConnectModalRef.current?.(), 0)
              }
            } finally {
              pendingRecoveryRef.current = false
            }
          })()
        },
      })
    },
    [action, config, reconnectAsync, toastId],
  )

  return { consumeRetryFlag, showError, ackSuccess }
}
