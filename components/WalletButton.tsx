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
  const { address, isConnected } = useAccount()
  const { openAccountModal } = useAccountModal()
  const { openConnectModal } = useConnectModal()
  const [displayName, setDisplayName] = useState<string | null>(null)

  useEffect(() => { setMounted(true) }, [])

  useEffect(() => {
    if (!address) { setDisplayName(null); return }
    fetch(`/api/profile/${address}`)
      .then((r) => r.json())
      .then((d) => setDisplayName(d.profile?.username || d.profile?.ensName || null))
      .catch(() => {})
  }, [address])

  // Hidden placeholder during SSR / before hydration to avoid layout shift
  if (!mounted) {
    return (
      <div aria-hidden style={{ opacity: 0, pointerEvents: 'none', userSelect: 'none' }}>
        <button style={connectStyle}>connect</button>
      </div>
    )
  }

  if (!isConnected || !address) {
    return (
      <button onClick={openConnectModal} style={connectStyle}>
        connect
      </button>
    )
  }

  return (
    <button
      onClick={() => openAccountModal?.()}
      className="text-[#888] hover:text-[#efefef] transition-colors"
      style={addressStyle}
    >
      {displayName ?? shortAddress(address)}
    </button>
  )
}
