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
  // When set, the entire 1200x800 frame is the artwork (object-fit
  // contain, dark letterbox if the source isn't 3:2). Title + creator
  // live in the cast text, not on the image. Omitted → text-only
  // branded card (video moments without a poster, text moments,
  // collections without a cover, etc.).
  imageUrl?: string
}

// Satori (Next's OG renderer) doesn't handle text-overflow gracefully;
// cap up front to keep the layout within the card.
const MAX_TITLE_LEN = 50

export function shareCard({ label, title, creator, imageUrl }: ShareCardProps) {
  if (imageUrl) {
    // Full-frame hero. <img> + objectFit:contain rather than CSS
    // background because Satori silently treats background-size:contain
    // as cover-like, hard-cropping non-square sources.
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#0a0a0a',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          width={1200}
          height={800}
          style={{
            maxWidth: '100%',
            maxHeight: '100%',
            objectFit: 'contain',
          }}
        />
      </div>
    )
  }

  const displayName =
    title.length > MAX_TITLE_LEN ? `${title.slice(0, MAX_TITLE_LEN - 1)}…` : title
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
