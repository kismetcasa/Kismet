// Shared share-card layout for opengraph-image routes. Both the
// collection and moment cards render the same branded frame (KISMET
// ART header, kicker label, large title, optional "by …" line) over
// a dark gradient; only the label, title source, and creator origin
// differ. Keeping the layout here means a visual tweak only happens
// in one place.

export const SHARE_CARD_SIZE = { width: 1200, height: 630 }
export const SHARE_CARD_CONTENT_TYPE = 'image/png'

interface ShareCardProps {
  /** Kicker shown top-right (e.g. 'COLLECTION', 'MOMENT', 'VIDEO', 'WRITING'). */
  label: string
  /** Main display title; truncated to fit the frame. */
  title: string
  /** Optional creator handle / short-address shown under the title. */
  creator?: string
}

// Satori (Next's OG renderer) doesn't handle text-overflow gracefully,
// so we cap the title up front to keep the layout within 1200×630.
const MAX_TITLE_LEN = 50

export function shareCard({ label, title, creator }: ShareCardProps) {
  const displayName =
    title.length > MAX_TITLE_LEN ? `${title.slice(0, MAX_TITLE_LEN - 3)}…` : title

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
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <div style={{ fontSize: 28, letterSpacing: 6, color: '#666' }}>
          KISMET
        </div>
        <div style={{ fontSize: 20, letterSpacing: 4, color: '#444' }}>
          {label}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            fontSize: 80,
            lineHeight: 1.1,
            color: '#efefef',
            letterSpacing: -1,
            maxWidth: 1000,
          }}
        >
          {displayName}
        </div>
        {creator && (
          <div
            style={{
              fontSize: 32,
              color: '#888',
              marginTop: 32,
            }}
          >
            by {creator}
          </div>
        )}
      </div>
    </div>
  )
}
