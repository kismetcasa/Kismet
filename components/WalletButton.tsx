'use client'

import { ConnectButton } from '@rainbow-me/rainbowkit'
import { shortAddress } from '@/lib/inprocess'

export function WalletButton() {
  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openConnectModal, mounted }) => {
        const ready = mounted
        const connected = ready && account && chain

        return (
          <div
            {...(!ready && {
              'aria-hidden': true,
              style: { opacity: 0, pointerEvents: 'none', userSelect: 'none' },
            })}
          >
            {!connected ? (
              <button
                onClick={openConnectModal}
                style={{
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
                }}
              >
                connect
              </button>
            ) : (
              <button
                onClick={openAccountModal}
                className="text-[#888] hover:text-[#efefef] transition-colors"
                style={{
                  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                  fontSize: '11px',
                  padding: 0,
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  letterSpacing: '0.05em',
                }}
              >
                {shortAddress(account.address)}
              </button>
            )}
          </div>
        )
      }}
    </ConnectButton.Custom>
  )
}
