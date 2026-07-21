'use client'

import { useState } from 'react'
import { Check } from 'lucide-react'

// Custom icon: "0" centered where the front (top-left) square used to be, and
// "x" centered where the back (bottom-right) square used to be — letters
// replace the boxes, with the "x" slightly overlapping the "0" in the same
// way the back square slightly overlapped the front square.
function ZeroXIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
      fontWeight="600"
    >
      {/* 0 in the front-square position (top-left) */}
      <text x="9" y="9" fontSize="13" textAnchor="middle" dominantBaseline="central">0</text>
      {/* x in the back-square position (bottom-right), slightly overlapping the 0 */}
      <text x="15" y="15" fontSize="13" textAnchor="middle" dominantBaseline="central">x</text>
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
      className={`flex-shrink-0 text-subtle hover:text-dim transition-colors ${className}`}
    >
      {copied
        ? <Check size={size} className="text-[#6ee7b7]" />
        : <ZeroXIcon size={size} />
      }
    </button>
  )
}
