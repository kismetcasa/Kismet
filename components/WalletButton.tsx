'use client'

import { ConnectButton } from '@rainbow-me/rainbowkit'

interface WalletButtonProps {
  displayName?: string
}

export function WalletButton({ displayName }: WalletButtonProps = {}) {
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
                className="hover:opacity-80 transition-opacity"
                style={{
                  background: 'linear-gradient(135deg, #8B5CF6, #C084FC)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                  fontSize: '11px',
                  padding: 0,
                  border: 'none',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  letterSpacing: '0.05em',
                }}
              >
                {displayName ?? account.displayName}
              </button>
            )}
          </div>
        )
      }}
    </ConnectButton.Custom>
  )
}
