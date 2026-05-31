'use client'

import { useEffect } from 'react'

// Last-resort error boundary. Fires only when the root layout or a
// generateMetadata throws — error.tsx misses both. Must declare its own
// <html>/<body> because it REPLACES the root layout when active. Only
// fires in production builds; `next dev` short-circuits it.

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string }
}) {
  useEffect(() => {
    console.error('[global-error]', { name: error.name, digest: error.digest })
  }, [error])

  return (
    <html lang="en">
      <body
        style={{
          background: '#0d0d0d',
          color: '#efefef',
          fontFamily: 'ui-monospace, monospace',
          margin: 0,
          minHeight: '100vh',
        }}
      >
        <div
          role="alert"
          style={{
            maxWidth: 480,
            margin: '64px auto',
            padding: 16,
            textAlign: 'center',
          }}
        >
          <h2 style={{ fontSize: 14, marginBottom: 8 }}>application error</h2>
          {error.digest && (
            <p style={{ fontSize: 10, opacity: 0.5, marginBottom: 16 }}>
              reference: <code>{error.digest}</code>
            </p>
          )}
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 16px',
              fontSize: 12,
              background: 'transparent',
              color: '#efefef',
              border: '1px solid #2a2a2a',
              cursor: 'pointer',
            }}
          >
            reload
          </button>
        </div>
      </body>
    </html>
  )
}
