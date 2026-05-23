import { ImageResponse } from 'next/og'
import { isAddress } from '@/lib/address'
import { shortAddress } from '@/lib/inprocess'
import { resolveProfileWithSiblings } from '@/lib/addressUnion'
import { isSafePublicHttpsUrl } from '@/lib/safeUrl'

// Profile share card — branded 1200x800 (3:2) PNG used as both the OG
// image and the Farcaster Mini App embed image. Matches the styling of
// the moment / collection opengraph-image routes: dark gradient bg,
// KISMET ART corner label, large display name. Adds a circular avatar
// in the center.
//
// FC pfp (when verified) preferred over Kismet upload; both fall back
// to the address-derived gradient blockie that ProfileAvatar uses on
// the web side, keeping a consistent visual identity across surfaces.

export const size = { width: 1200, height: 800 }
export const contentType = 'image/png'

interface Props {
  params: Promise<{ address: string }>
}

// Same gradient derivation as components/ProfileAvatar.tsx — copied
// (rather than imported) because that file is 'use client' and pulling
// it into a server-side ImageResponse route would force the React DOM
// runtime to load too. The function is pure and small; the dupe is
// cheaper than a refactor for shared address-color logic.
function addressToGradient(address: string): { from: string; to: string; angle: number } {
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

export default async function Image({ params }: Props) {
  const { address } = await params

  let displayName = isAddress(address) ? shortAddress(address) : address
  let secondary = ''
  let avatarUrl: string | null = null

  if (isAddress(address)) {
    // Sibling-aware: when the queried address has no Kismet profile but
    // a sibling FC-verified address does, the helper surfaces the
    // sibling's username/avatar so share cards still read as "@kismetcasa"
    // rather than the raw hex when the user shares any of their wallets.
    const { profile, farcaster } = await resolveProfileWithSiblings(address)
    // Display chain: explicit Kismet username > FC username > FC display
    // name > shortAddress. Matches the precedence in /api/profile and
    // components/Nav.tsx.
    displayName =
      profile.username ||
      farcaster?.username ||
      farcaster?.displayName ||
      shortAddress(address)
    // Below the name: the "other half" of the identity — if we showed a
    // username up top, surface the FID + address; if we fell back to a
    // shortAddress, show the FID (when present) or nothing.
    if (farcaster?.fid) {
      secondary =
        displayName === shortAddress(address)
          ? `FID ${farcaster.fid}`
          : `FID ${farcaster.fid} · ${shortAddress(address)}`
    }
    avatarUrl = profile.avatarUrl || farcaster?.pfpUrl || null
  }

  // SSRF guard at the render sink: ImageResponse fetches <img src> server-
  // side. Drop any avatar that isn't a public https host (covers values
  // stored before input validation existed, and the FC pfp fallback). An
  // unsafe URL just renders the no-avatar layout.
  if (avatarUrl && !isSafePublicHttpsUrl(avatarUrl)) avatarUrl = null

  // Truncate to keep within the 1200x800 frame. The display-name font
  // size (96) caps comfortably around ~22 chars; we leave headroom.
  const safeName =
    displayName.length > 30 ? `${displayName.slice(0, 28)}…` : displayName

  const grad = isAddress(address)
    ? addressToGradient(address)
    : { from: '#444', to: '#222', angle: 135 }

  return new ImageResponse(
    (
      <div
        style={{
          height: '100%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          backgroundImage: 'linear-gradient(135deg, #1a1a1a 0%, #0a0a0a 100%)',
          padding: '72px',
          justifyContent: 'space-between',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div style={{ fontSize: 28, letterSpacing: 6, color: '#666' }}>
            KISMET ART
          </div>
          <div style={{ fontSize: 20, letterSpacing: 4, color: '#444' }}>
            PROFILE
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 1,
            marginTop: -40,
          }}
        >
          {/* Avatar — 240x240 circle. img tag works inside ImageResponse
              as long as the URL is reachable from the server; FC pfp
              hosts (imagedelivery.net, etc.) all are. If the img fails
              to load Satori falls through to the gradient parent so a
              broken pfp URL never produces a blank slot. */}
          <div
            style={{
              width: 240,
              height: 240,
              borderRadius: 9999,
              background: `linear-gradient(${grad.angle}deg, ${grad.from}, ${grad.to})`,
              overflow: 'hidden',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {avatarUrl && (
              <img
                src={avatarUrl}
                alt=""
                width={240}
                height={240}
                style={{ width: 240, height: 240, objectFit: 'cover' }}
              />
            )}
          </div>
          <div
            style={{
              fontSize: 96,
              lineHeight: 1.1,
              color: '#efefef',
              letterSpacing: -1,
              marginTop: 48,
              maxWidth: 1000,
              textAlign: 'center',
            }}
          >
            {safeName}
          </div>
          {secondary && (
            <div
              style={{
                fontSize: 28,
                color: '#888',
                marginTop: 24,
                letterSpacing: 0.5,
              }}
            >
              {secondary}
            </div>
          )}
        </div>
      </div>
    ),
    { ...size },
  )
}
