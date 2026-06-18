import { ImageResponse } from 'next/og'
import { isAddress } from '@/lib/address'
import { shortAddress } from '@/lib/inprocess'
import { resolveProfileWithSiblings } from '@/lib/addressUnion'
import { isSafePublicHttpsUrl } from '@/lib/safeUrl'
import { getProfileTheme, type ProfileTheme } from '@/lib/profileTheme'
import { getArtistEarnings, type ArtistEarnings } from '@/lib/stats'
import { isEarningsPublic } from '@/lib/earningsVisibility'
import { formatEarningsValue, type EarningsMetric } from '@/lib/earningsFormat'

// Profile share card — branded 1200x800 (3:2) PNG used as both the OG
// image and the Farcaster Mini App embed image. Matches the styling of
// the moment / collection opengraph-image routes: dark gradient bg,
// KISMET ART corner label, large display name. Adds a circular avatar
// in the center.
//
// FC pfp (when verified) preferred over Kismet upload; both fall back
// to the address-derived gradient blockie that ProfileAvatar uses on
// the web side, keeping a consistent visual identity across surfaces.
//
// When the profile has a content-derived theme, the card reflects it: a dark
// palette-gradient background, a LINEAR approximation of the avatar palette ring
// (Satori has no conic-gradient), an accented label, and a palette swatch strip.
// No moment art is fetched — Satori can't blur it, and the palette reads cleaner
// with no added fetch/SSRF surface.

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
  let theme: ProfileTheme | null = null

  if (isAddress(address)) {
    // Sibling-aware: when the queried address has no Kismet profile but
    // a sibling FC-verified address does, the helper surfaces the
    // sibling's username/avatar so share cards still read as "@kismetcasa"
    // rather than the raw hex when the user shares any of their wallets.
    //
    // The theme read is parallelized with the profile resolve (both hit Redis),
    // so the themed card adds no latency; safeRead degrades to null on failure.
    const [{ profile, farcaster }, t] = await Promise.all([
      resolveProfileWithSiblings(address),
      getProfileTheme(address),
    ])
    theme = t
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

  // Public earnings (primary paid sales) for the card. Best-effort — a failure
  // just omits the stat line rather than breaking the card.
  let earnings: ArtistEarnings | null = null
  if (isAddress(address)) {
    try {
      // Earnings are private by default — only surface them on the share card
      // once the artist has pinned them public.
      if (await isEarningsPublic(address)) earnings = await getArtistEarnings(address)
    } catch {
      earnings = null
    }
  }
  // Prefer the blended USD headline; fall back to native ETH only if the price
  // lookup is unavailable (rare) so an ETH earner never shows "$0".
  const cardDenom: EarningsMetric =
    earnings && earnings.usd <= 0 && earnings.eth > 0 ? 'eth' : 'usd'

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

  // Themed card bg uses the palette's dimmed backdrop stops (L<=0.13 by
  // construction, so #efefef text stays comfortably above 10:1).
  const cardBg = theme
    ? `linear-gradient(${theme.geometry.angle}deg, ${theme.palette.bgFrom}, ${theme.palette.bgTo})`
    : 'linear-gradient(135deg, #1a1a1a 0%, #0a0a0a 100%)'

  // Avatar disc (address-gradient bg + optional pfp). img works inside
  // ImageResponse as long as the URL is reachable; if it fails Satori falls
  // through to the gradient parent so a broken pfp never produces a blank slot.
  // Wrapped in the palette ring below when themed.
  const avatarCircle = (
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
  )

  return new ImageResponse(
    (
      <div
        style={{
          height: '100%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          backgroundImage: cardBg,
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
          <div style={{ fontSize: 20, letterSpacing: 4, color: theme ? theme.palette.primary : '#444' }}>
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
          {/* Palette ring (themed) — a LINEAR gradient border around the avatar,
              approximating the web's conic ring (Satori has no conic-gradient). */}
          {theme ? (
            <div
              style={{
                display: 'flex',
                padding: 10,
                borderRadius: 9999,
                background: `linear-gradient(${theme.geometry.ringStart}deg, ${theme.palette.ringStops.join(', ')})`,
              }}
            >
              {avatarCircle}
            </div>
          ) : (
            avatarCircle
          )}
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
          {earnings && earnings.mints > 0 && (
            <div style={{ display: 'flex', alignItems: 'baseline', marginTop: 28 }}>
              <div style={{ fontSize: 52, color: theme ? theme.palette.primary : '#efefef' }}>
                {formatEarningsValue(cardDenom, earnings)}
              </div>
              <div style={{ fontSize: 26, color: '#888', marginLeft: 18 }}>
                {`${earnings.mints} mints`}
              </div>
            </div>
          )}
          {/* Palette swatch strip — the clearest "themed" signal. marginLeft
              (not flex gap) for spacing, since Satori's gap support is version-
              dependent. */}
          {theme && (
            <div style={{ display: 'flex', marginTop: 32 }}>
              {theme.palette.ringStops.slice(0, 5).map((c, i) => (
                <div
                  key={i}
                  style={{ width: 56, height: 14, borderRadius: 7, background: c, marginLeft: i ? 10 : 0 }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    ),
    { ...size },
  )
}
