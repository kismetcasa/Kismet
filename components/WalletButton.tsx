'use client'

import { useEffect, useState } from 'react'
import { useAccount } from 'wagmi'
import { useAccountModal, useConnectModal } from '@rainbow-me/rainbowkit'
import { shortAddress } from '@/lib/inprocess'

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
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [nameResolved, setNameResolved] = useState(false)

  useEffect(() => { setMounted(true) }, [])

  useEffect(() => {
    if (!address) { setDisplayName(null); setNameResolved(false); return }
    setNameResolved(false)
    fetch(`/api/profile/${address}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setDisplayName(d.profile?.username || d.profile?.ensName || null))
      .catch(() => {})
      .finally(() => setNameResolved(true))
  }, [address])

  // Hide until state is truly settled:
  // - 'reconnecting'/'connecting': wagmi is replaying localStorage — don't show anything yet
  // - 'disconnected': safe to show connect button immediately
  // - 'connected': wait for profile fetch so we jump straight to the final name, never 0x → name
  const settled = mounted && (
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
      {!isConnected || !address ? (
        <button onClick={openConnectModal} style={connectStyle}>
          connect
        </button>
      ) : (
        <button
          onClick={() => openAccountModal?.()}
          className="text-dim hover:text-ink transition-colors"
          style={addressStyle}
        >
          {displayName ?? shortAddress(address)}
        </button>
      )}
    </div>
  )
}
