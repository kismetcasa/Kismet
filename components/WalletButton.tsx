'use client'

import { useEffect, useState } from 'react'
import { useAccount } from 'wagmi'
import { useAccountModal, useConnectModal } from '@rainbow-me/rainbowkit'
import { shortAddress } from '@/lib/inprocess'
import { useFarcaster } from '@/providers/FarcasterProvider'

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
  const [mounted, setMounted] = useState(false)
  const { address, isConnected, status } = useAccount()
  const { openAccountModal } = useAccountModal()
  const { openConnectModal } = useConnectModal()
  const { isInMiniApp, identity: fcIdentity } = useFarcaster()
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [nameResolved, setNameResolved] = useState(false)

  useEffect(() => { setMounted(true) }, [])

  // Inside a Mini App, the user is signed in via Quick Auth (no wallet
  // connection prompt). Prefer the Farcaster-resolved address and the
  // host-provided username/pfp so the UI paints with the user's FC
  // identity without waiting for /api/profile.
  const effectiveAddress = isInMiniApp ? fcIdentity?.address ?? address : address
  const effectiveConnected = isInMiniApp
    ? !!fcIdentity?.address || isConnected
    : isConnected

  useEffect(() => {
    if (!effectiveAddress) { setDisplayName(null); setNameResolved(false); return }
    setNameResolved(false)
    fetch(`/api/profile/${effectiveAddress}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setDisplayName(
        d.profile?.displayName || d.profile?.username || d.profile?.ensName || null,
      ))
      .catch(() => {})
      .finally(() => setNameResolved(true))
  }, [effectiveAddress])

  // Hide until state is truly settled:
  // - 'reconnecting'/'connecting': wagmi is replaying localStorage — don't show anything yet
  // - 'disconnected': safe to show connect button immediately
  // - 'connected': wait for profile fetch so we jump straight to the final name, never 0x → name
  // - mini app: settle as soon as the FC identity has an address (no wagmi state to wait on)
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
          // In Mini App context there's no RainbowKit account modal to
          // open (no wagmi connection). Clicking the name is a no-op for
          // now; Phase 3 will wire the miniapp wallet connector and
          // re-enable the account modal.
          onClick={() => isInMiniApp ? undefined : openAccountModal?.()}
          className="text-[#888] hover:text-[#efefef] transition-colors"
          style={addressStyle}
        >
          {displayName ?? fcIdentity?.username ?? shortAddress(effectiveAddress)}
        </button>
      )}
    </div>
  )
}
