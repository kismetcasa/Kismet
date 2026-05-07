'use client'

import { useState, useId } from 'react'
import { Check } from 'lucide-react'

// Custom icon: copy-icon structure (two overlapping squares) but with a "0"
// ellipse inside the front square and "x" crossing lines in the back square's
// visible (bottom-right peeking) area. The mask hides the back square's stroke
// in the region covered by the front square, matching lucide's copy icon look.
function ZeroXIcon({ size }: { size: number }) {
  const rawId = useId()
  const id = `zx${rawId.replace(/[^a-zA-Z0-9]/g, '')}`
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <defs>
        <mask id={id}>
          <rect width="24" height="24" fill="white" />
          {/* black region = front square area — hides back square stroke behind it */}
          <rect x="2" y="2" width="14" height="14" rx="2" fill="black" />
        </mask>
      </defs>
      {/* Back square — only the portion outside the front square is drawn */}
      <rect width="14" height="14" x="8" y="8" rx="2" mask={`url(#${id})`} />
      {/* x mark in the visible bottom-right area of the back square */}
      <line x1="14.5" y1="16.5" x2="20.5" y2="21.5" strokeWidth="1.5" />
      <line x1="20.5" y1="16.5" x2="14.5" y2="21.5" strokeWidth="1.5" />
      {/* Front square — open path identical to lucide Copy, stops before overlap */}
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
      {/* 0 oval inside the front square */}
      <ellipse cx="9" cy="9" rx="2.5" ry="3" strokeWidth="1.5" />
    </svg>
  )
}

interface CopyAddressProps {
  address: string
  size?: number
  className?: string
}

export function CopyAddress({ address, size = 13, className = '' }: CopyAddressProps) {
  const [copied, setCopied] = useState(false)

  function handleCopy(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    navigator.clipboard.writeText(address).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      onClick={handleCopy}
      title={address}
      className={`flex-shrink-0 text-[#444] hover:text-[#888] transition-colors ${className}`}
    >
      {copied
        ? <Check size={size} className="text-[#6ee7b7]" />
        : <ZeroXIcon size={size} />
      }
    </button>
  )
}
