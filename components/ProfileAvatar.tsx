'use client'

import { useState } from 'react'

interface ProfileAvatarProps {
  address: string
  avatarUrl?: string
  size?: number
  editable?: boolean
  onEdit?: () => void
  clickable?: boolean
}

function addressToGradient(address: string): { from: string; to: string; angle: number } {
  // padEnd defends against short/empty inputs (e.g. the placeholder
  // address used during the FC-identity-but-no-resolved-address window
  // — the gradient is invisible under the FC pfp anyway, but the
  // parseInt('', 16) → NaN would still produce a black slot if the
  // image fails to load).
  const hex = address.replace('0x', '').toLowerCase().padEnd(14, '0')
  const r1 = parseInt(hex.slice(0, 2), 16)
  const g1 = parseInt(hex.slice(2, 4), 16)
  const b1 = parseInt(hex.slice(4, 6), 16)
  const r2 = parseInt(hex.slice(6, 8), 16)
  const g2 = parseInt(hex.slice(8, 10), 16)
  const b2 = parseInt(hex.slice(10, 12), 16)
  const angle = parseInt(hex.slice(12, 14), 16) % 360
  return {
    from: `rgb(${r1},${g1},${b1})`,
    to: `rgb(${r2},${g2},${b2})`,
    angle,
  }
}

export function ProfileAvatar({ address, avatarUrl, size = 40, editable = false, onEdit, clickable = false }: ProfileAvatarProps) {
  const [imgError, setImgError] = useState(false)
  const grad = addressToGradient(address)

  const style: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    background: `linear-gradient(${grad.angle}deg, ${grad.from}, ${grad.to})`,
    flexShrink: 0,
    position: 'relative',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  }

  return (
    <div
      style={style}
      className={[
        'select-none transition-all duration-150',
        clickable
          ? 'cursor-pointer hover:scale-105 active:scale-95 hover:shadow-[0_0_0_2px_rgba(255,255,255,0.18)]'
          : 'cursor-default',
      ].join(' ')}
    >
      {avatarUrl && !imgError && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt="avatar"
          // Explicit width/height attributes reserve the box size for
          // the layout engine before the image starts decoding —
          // prevents the 1-frame gradient flash on slow networks.
          // objectFit: cover + objectPosition: center together handle
          // non-square FC pfp sources (some are 1:1, some are 4:3 from
          // older clients) by center-cropping to the circle.
          width={size}
          height={size}
          // loading=eager: avatar is above-the-fold in nav and
          // profile pages, never lazy. decoding=async: lets the decode
          // run off the main thread so it doesn't block paint.
          loading="eager"
          decoding="async"
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: 'center',
            position: 'absolute',
            inset: 0,
            display: 'block',
          }}
          onError={() => setImgError(true)}
        />
      )}
      {editable && onEdit && (
        <button
          onClick={onEdit}
          style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          className="bg-black/50 opacity-0 hover:opacity-100 transition-opacity text-white text-xs font-mono"
        >
          edit
        </button>
      )}
    </div>
  )
}
