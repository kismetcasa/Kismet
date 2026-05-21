// Shared OG share-card frame for /collection and /moment opengraph routes.
// Edit the layout here once instead of in both files.

// 1200x800 = 3:2, matching Farcaster's Mini App embed spec. Twitter /
// Discord / iMessage render any sane aspect ratio fine — they were
// previously the only consumers of this card size — so aligning with
// FC costs nothing on those surfaces.
export const SHARE_CARD_SIZE = { width: 1200, height: 800 }
export const SHARE_CARD_CONTENT_TYPE = 'image/png'

interface ShareCardProps {
  label: string
  title: string
  creator?: string
  // When set, the card renders the resolved poster on the left and the
  // KISMET / title / creator chrome on the right. Omitted → text-only
  // branded card (video moments without a poster, text moments,
  // collections without a cover, etc.).
  imageUrl?: string
}

// Satori (Next's OG renderer) doesn't handle text-overflow gracefully;
// cap up front to keep the layout within the card.
const MAX_TITLE_LEN = 50
const MAX_TITLE_LEN_WITH_IMAGE = 40

export function shareCard({ label, title, creator, imageUrl }: ShareCardProps) {
  const cap = imageUrl ? MAX_TITLE_LEN_WITH_IMAGE : MAX_TITLE_LEN
  const displayName =
    title.length > cap ? `${title.slice(0, cap - 1)}…` : title

  if (imageUrl) {
    // Side-by-side hero layout: 800x800 image on the left, 400-wide
    // text panel on the right. Image uses <img> + objectFit:contain
    // (rather than backgroundSize:contain on a div) because Satori
    // honors objectFit on <img> reliably but silently falls back to
    // cover-like behavior for CSS backgrounds, hard-cropping non-
    // square sources. If Satori can't fetch the image, the panel
    // still renders and the area falls back to backgroundColor —
    // graceful degradation.
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'row',
          backgroundColor: '#0a0a0a',
        }}
      >
        <div
          style={{
            width: '800px',
            height: '800px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#161616',
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl}
            width={800}
            height={800}
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              objectFit: 'contain',
            }}
          />
        </div>
        <div
          style={{
            width: '400px',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            padding: '56px 40px',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: 26, letterSpacing: 6, color: '#888' }}>KISMET</div>
            <div style={{ fontSize: 16, letterSpacing: 4, color: '#555', marginTop: 12 }}>{label}</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: 56, lineHeight: 1.1, color: '#efefef', letterSpacing: -0.5 }}>
              {displayName}
            </div>
            {creator && (
              <div style={{ fontSize: 22, color: '#888', marginTop: 16 }}>by {creator}</div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 28, letterSpacing: 6, color: '#666' }}>KISMET</div>
        <div style={{ fontSize: 20, letterSpacing: 4, color: '#444' }}>{label}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontSize: 80, lineHeight: 1.1, color: '#efefef', letterSpacing: -1, maxWidth: 1000 }}>
          {displayName}
        </div>
        {creator && (
          <div style={{ fontSize: 32, color: '#888', marginTop: 32 }}>by {creator}</div>
        )}
      </div>
    </div>
  )
}
