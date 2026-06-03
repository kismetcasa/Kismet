'use client'

import { useEffect, useRef } from 'react'
import { useConfig } from 'wagmi'

// Mobile OSes (iOS Safari especially) suspend the WebSocket transport
// when the tab is backgrounded — the local TCP layer keeps reporting
// readyState===1, so wagmi keeps reporting isConnected: true. The
// dead socket only becomes visible on the next outbound request, when
// the user taps Collect and hits "User disconnected" / "Expired." /
// "Session settlement failed." (the wording the auth-error regex in
// lib/toast.ts was widened to catch).
//
// On visibility regain we ping the relay; the WC `wc_sessionPing` RPC
// is marked prompt:false so the peer wallet auto-answers without any
// UI. If the ping times out, restartTransport closes and reopens the
// socket cleanly. Both are silent — zero friction in the happy path.
// The recovery flow in useWalletRecovery remains the backstop for the
// cases the heal can't catch (mid-tab death, half-broken host). The
// deep field chain (signer.client.core.relayer) is typed-public per
// WC's .d.ts but optional-chained throughout so any future field-rename
// degrades to silent no-op instead of crashing.

// At most one heal per 30s. Real foreground-after-background transitions
// are sparse; rapid visibility flips (focus shifts within the OS task
// switcher, for instance) shouldn't burn cycles.
const THROTTLE_MS = 30_000
// Ping's own default timeout is 5 minutes per the WC spec — far too
// long for a UX-facing health check. Cap at 3s so a truly dead socket
// transitions to restartTransport quickly enough to be ready before
// the user taps a button.
const PING_TIMEOUT_MS = 3_000

interface WalletConnectProvider {
  session?: { topic: string }
  signer?: {
    client?: {
      ping?: (args: { topic: string }) => Promise<void>
      core?: {
        relayer?: {
          restartTransport?: () => Promise<void>
        }
      }
    }
  }
}

export function useWalletConnectKeepalive(): void {
  const config = useConfig()
  const lastHealAtRef = useRef(0)
  // Each heal involves an async ping race; serialize so a second
  // visibility event doesn't start an overlapping run.
  const healInFlightRef = useRef(false)

  useEffect(() => {
    const heal = async () => {
      if (document.visibilityState !== 'visible') return
      if (healInFlightRef.current) return
      const now = Date.now()
      if (now - lastHealAtRef.current < THROTTLE_MS) return
      healInFlightRef.current = true

      try {
        const wc = config.connectors.find((c) => c.id === 'walletConnect')
        if (!wc) return
        const rawProvider = await wc.getProvider().catch(() => null)
        if (!rawProvider) return
        const provider = rawProvider as WalletConnectProvider
        const topic = provider.session?.topic
        const ping = provider.signer?.client?.ping
        // No active WC session (user is on injected / Mini App / not yet
        // connected via WC) — nothing to heal.
        if (!topic || !ping) return
        // Throttle ONLY when we found a session to heal; otherwise a non-WC
        // user's visibility events would burn the budget pointlessly.
        lastHealAtRef.current = now

        const pingOk = await Promise.race<boolean>([
          ping({ topic }).then(() => true).catch(() => false),
          new Promise<boolean>((resolve) => {
            setTimeout(() => resolve(false), PING_TIMEOUT_MS)
          }),
        ])

        if (!pingOk) {
          // Socket appears dead. restartTransport closes the current
          // WebSocket then dials a fresh one; idempotent-ish on a
          // healthy socket (the WC core guards against double-dial).
          await provider.signer?.client?.core?.relayer
            ?.restartTransport?.()
            .catch(() => {})
        }
      } catch {
        // Any unexpected throw degrades silently. useWalletRecovery
        // catches the after-the-fact case if this preventive layer
        // misses or fails.
      } finally {
        healInFlightRef.current = false
      }
    }

    const onVisibilityChange = () => {
      void heal()
    }
    // Safari's bfcache restoration fires pageshow but NOT
    // visibilitychange; we need both for full mobile coverage. Duplicate
    // firings during a normal foreground (both events firing on a real
    // tab switch) are absorbed by the throttle.
    const onPageShow = () => {
      void heal()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [config])
}

/**
 * Mount-only wrapper around the keepalive hook. Drop a single instance
 * inside the WagmiProvider tree to enable the heal app-wide.
 */
export function WalletConnectKeepalive(): null {
  useWalletConnectKeepalive()
  return null
}
