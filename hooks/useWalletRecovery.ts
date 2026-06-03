'use client'

import { useCallback, useRef } from 'react'
import { useConfig, useReconnect } from 'wagmi'
import { getAccount } from '@wagmi/core'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { isAuthError, toastError, toastReloadRecovery } from '@/lib/toast'

interface UseWalletRecoveryReturn {
  // Read-and-clear the "this call is the post-reconnect retry" flag. Call
  // once at the top of the wallet-write callback; the returned boolean
  // drives the layer-2-vs-layer-3 branch in `showError`.
  consumeRetryFlag: () => boolean
  // Render the right recovery toast for the error. Layer-3 (Reload) when
  // a reconnect retry just failed again with an auth error; layer-2
  // (Reconnect → retry/openConnectModal) otherwise. `retry` is invoked
  // after a successful reconnect and should re-run the same wallet write
  // with the same args — typically `() => void runRef.current(args)` so
  // it picks up the latest hook closure.
  showError: (err: unknown, isRetryAfterRecovery: boolean, retry: () => void) => void
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

  const consumeRetryFlag = useCallback(() => {
    const v = isRetryAfterRecoveryRef.current
    isRetryAfterRecoveryRef.current = false
    return v
  }, [])

  const showError = useCallback(
    (err: unknown, isRetryAfterRecovery: boolean, retry: () => void) => {
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
          void (async () => {
            // Some connectors throw on reconnect; either way the
            // post-reconnect getAccount check is the source of truth.
            await reconnectAsync().catch(() => {})
            const account = getAccount(config)
            if (account.status === 'connected' && account.address) {
              isRetryAfterRecoveryRef.current = true
              retry()
            } else {
              // Dismiss the "Reconnecting…" toast before the wallet
              // picker takes over — otherwise it lingers in the corner.
              toast.dismiss(toastId)
              openConnectModalRef.current?.()
            }
          })()
        },
      })
    },
    [action, config, reconnectAsync, toastId],
  )

  return { consumeRetryFlag, showError }
}
