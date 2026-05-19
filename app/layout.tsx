import type { Metadata } from 'next'
import { Toaster } from 'sonner'
import { Providers } from '@/providers/WagmiProvider'
import { FarcasterProvider } from '@/providers/FarcasterProvider'
import { Nav } from '@/components/Nav'
import { buildFarcasterEmbed } from '@/lib/farcasterEmbed'
import { SITE_URL } from '@/lib/siteUrl'
import './globals.css'

export const metadata: Metadata = {
  // Resolves relative URLs in generateMetadata across the app (og:image
  // in particular). Override via NEXT_PUBLIC_SITE_URL for staging or
  // other non-prod hosts; default to the canonical apex domain so
  // share cards always point at production.
  metadataBase: new URL(SITE_URL),
  title: 'Kismet',
  description: 'Artists and collectors converge on Kismet',
  openGraph: {
    title: 'Kismet',
    description: 'Artists and collectors converge on Kismet',
  },
  // Farcaster Mini App embed for the homepage. When the apex URL is
  // shared in a cast, this is the rich card that renders + launches the
  // Mini App. Per-route embeds (moment, collection, profile) are added
  // in their own generateMetadata in Phase 4.
  other: buildFarcasterEmbed({
    imageUrl:
      process.env.NEXT_PUBLIC_FARCASTER_EMBED_IMAGE_URL ?? `${SITE_URL}/embed-default.png`,
    buttonTitle: process.env.NEXT_PUBLIC_FARCASTER_BUTTON_TITLE ?? 'Create Kismet',
    action: {
      url: SITE_URL,
      name: process.env.NEXT_PUBLIC_FARCASTER_APP_NAME ?? 'Kismet',
      splashImageUrl:
        process.env.NEXT_PUBLIC_FARCASTER_SPLASH_URL ?? `${SITE_URL}/splash.png`,
      splashBackgroundColor: process.env.NEXT_PUBLIC_FARCASTER_SPLASH_BG ?? '#ff87ce',
    },
  }),
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
        {/* Quick Auth token acquisition runs on every Mini App reload —
            preconnect shaves the TLS handshake off the critical path. */}
        <link rel="preconnect" href="https://auth.farcaster.xyz" />
        <link rel="dns-prefetch" href="https://permagate.io" />
        <link rel="dns-prefetch" href="https://g8way.io" />
        <link rel="dns-prefetch" href="https://ar-io.dev" />
        <link rel="dns-prefetch" href="https://ipfs.io" />
        <link rel="dns-prefetch" href="https://dweb.link" />
      </head>
      <body>
        <Providers>
          <FarcasterProvider>
            <Nav />
            <main
              // Push content below the nav, which is h-14 + safe-top tall.
              // 3.5rem = h-14 in Tailwind. Equivalent to the old `pt-14`
              // when --safe-top is 0 (regular web).
              className="min-h-screen min-h-dvh bg-[#0d0d0d]"
              style={{ paddingTop: 'calc(3.5rem + var(--safe-top))' }}
            >
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
          </FarcasterProvider>
        </Providers>
      </body>
    </html>
  )
}
