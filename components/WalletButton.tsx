'use client'

import { useEffect, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { useAccountModal, useConnectModal } from '@rainbow-me/rainbowkit'
import { shortAddress } from '@/lib/inprocess'
import { useFarcaster } from '@/providers/FarcasterProvider'
import { useHydrated } from '@/hooks/useHydrated'

const connectStyle: React.CSSProperties = {
  borderRadius: '9999px',
  background: 'white',
  fontFamily: 'var(--font-mono)',
  fontSize: '13px',
  fontWeight: 600,
  color: 'black',
  padding: '7px 18px',
  border: 'none',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  letterSpacing: '0.05em',
}

const addressStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: '11px',
  padding: 0,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  letterSpacing: '0.05em',
}

export function WalletButton() {
  const mounted = useHydrated()
  const { address, isConnected, status } = useAccount()
  const { openAccountModal } = useAccountModal()
  const { openConnectModal } = useConnectModal()
  const { isInMiniApp, identity: fcIdentity } = useFarcaster()
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [nameResolved, setNameResolved] = useState(false)
  // Tracks whether we've ever resolved a display name for this mount.
  // Used below to prevent the button from briefly disappearing when the
  // effectiveAddress shifts from the wagmi-connected wallet to the FC
  // primary after the FC identity lookup completes — a name was already
  // there, so we don't need to gate the UI on the re-fetch.
  const hasResolvedAtLeastOnce = useRef(false)

  // FC primary is the canonical identity here too — see Nav.tsx for the
  // rationale. Display label and shortAddress fallback both key off this
  // so the button text is consistent across web and Mini App. The wagmi
  // wallet (potentially different on web when the user connected a
  // sibling verified address) is still available via useAccount for the
  // RainbowKit account modal, which honestly discloses what's actually
  // signing.
  const effectiveAddress = fcIdentity?.address ?? address
  const effectiveConnected = !!fcIdentity?.address || isConnected

  useEffect(() => {
    if (!effectiveAddress) {
      setDisplayName(null)
      setNameResolved(false)
      hasResolvedAtLeastOnce.current = false
      return
    }
    // Only reset nameResolved on the FIRST resolution. Subsequent shifts
    // (e.g. wagmi address → FC primary after the identity lookup lands)
    // keep the existing displayName visible while the new one loads
    // rather than blinking the button out.
    if (!hasResolvedAtLeastOnce.current) setNameResolved(false)
    fetch(`/api/profile/${effectiveAddress}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => {
        setDisplayName(
          d.profile?.displayName || d.profile?.username || d.profile?.ensName || null,
        )
        hasResolvedAtLeastOnce.current = true
      })
      .catch(() => {})
      .finally(() => setNameResolved(true))
  }, [effectiveAddress])

  // Hide until state is truly settled:
  // - Mini App: settle as soon as the FC identity has an address — no
  //   wagmi state to wait on (and wagmi may still be probing the host
  //   wallet provider when the FC identity is already known)
  // - Web disconnected: safe to show the connect button immediately
  // - Web connected: wait for the profile fetch so we jump straight to
  //   the final name, never 0x → name
  const settled = mounted && (
    (isInMiniApp && !!fcIdentity?.address) ||
    status === 'disconnected' ||
    (status === 'connected' && nameResolved)
  )

  return (
    <div
      style={{
        opacity: settled ? 1 : 0,
        pointerEvents: settled ? 'auto' : 'none',
        // Only apply transition on reveal (not on hide) so it fades in cleanly
        transition: settled ? 'opacity 0.15s' : 'none',
      }}
      aria-hidden={!settled}
    >
      {!effectiveConnected || !effectiveAddress ? (
        <button onClick={openConnectModal} style={connectStyle}>
          connect
        </button>
      ) : (
        <button
          // Click semantics by surface + wagmi state:
          //
          //   Mini App + wagmi connected (normal Farcaster.xyz / FC iOS path):
          //     no-op. The host owns the wallet UX — the FC connector is
          //     wired up and signing flows through it. A RainbowKit
          //     modal here would be redundant and confusing.
          //
          //   Mini App + wagmi NOT connected (Base App, hosts whose
          //   eth_accounts handoff doesn't fire reliably):
          //     fall through to openConnectModal. Without this, the
          //     user sees their FC name (from Quick Auth) but can't
          //     actually mint/collect because wagmi has no signer —
          //     an inescapable broken state. The connect modal gives
          //     them an explicit retry path (host's injected provider,
          //     WalletConnect, etc).
          //
          //   Web + connected: openAccountModal (disconnect / switch).
          //   Web + disconnected: handled by the "connect" branch above.
          onClick={() => {
            if (isInMiniApp) {
              if (!isConnected) openConnectModal?.()
              return
            }
            openAccountModal?.()
          }}
          // Tooltip hints at the fallback action when wagmi never
          // connected — most discoverable thing we can do without
          // jamming an extra "(connect)" label into the nav.
          title={isInMiniApp && !isConnected ? 'tap to connect a signing wallet' : undefined}
          className="text-dim hover:text-ink transition-colors"
          style={addressStyle}
        >
          {displayName ?? fcIdentity?.username ?? shortAddress(effectiveAddress)}
        </button>
      )}
    </div>
  )
}
