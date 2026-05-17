import type { Metadata } from 'next'
import { Toaster } from 'sonner'
import { Providers } from '@/providers/WagmiProvider'
import { Nav } from '@/components/Nav'
import './globals.css'

export const metadata: Metadata = {
  // Resolves relative URLs in generateMetadata across the app (og:image
  // in particular). Override via NEXT_PUBLIC_SITE_URL for staging or
  // other non-prod hosts; default to the canonical custom domain so
  // share cards always point at production.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.kismet.art'),
  title: 'Kismet',
  description: 'mint, collect, and discover art on Kismet',
  openGraph: {
    title: 'Kismet',
    description: 'mint, collect, and discover art on Kismet',
  },
}

export default function RootLayout({
  children,
  modal,
}: {
  children: React.ReactNode
  // Parallel slot — populated by the @modal route tree when an
  // intercepting route matches. See app/@modal/default.tsx for the
  // null fallback when no intercepted route is active.
  modal: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        {/* Warm TLS to arweave.net (video tags + 'direct'-mode fallback still
            hit it from the browser). dns-prefetch covers the AR.IO + IPFS
            pool we walk through on proxy failure. */}
        <link rel="preconnect" href="https://arweave.net" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://permagate.io" />
        <link rel="dns-prefetch" href="https://g8way.io" />
        <link rel="dns-prefetch" href="https://ar-io.dev" />
        <link rel="dns-prefetch" href="https://ipfs.io" />
        <link rel="dns-prefetch" href="https://dweb.link" />
      </head>
      <body>
        <Providers>
          <Nav />
          <main className="pt-14 min-h-screen bg-[#0d0d0d]">
            {children}
          </main>
          {/* Intercepted routes render here as an overlay over the
              still-mounted {children} below. The feed stays alive
              underneath, scroll position preserved, card videos still
              playing — combined with SharedVideoProvider, the same
              video element CSS-transitions from card to overlay. */}
          {modal}
          <Toaster
            position="bottom-center"
            offset={{ bottom: 16 }}
            theme="dark"
            toastOptions={{
              style: {
                background: '#161616',
                border: '1px solid #2a2a2a',
                color: '#efefef',
                borderRadius: 0,
                fontFamily: 'var(--font-mono)',
                fontSize: '12px',
              },
            }}
          />
        </Providers>
      </body>
    </html>
  )
}
