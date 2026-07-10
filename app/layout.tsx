import type { Metadata } from 'next'
import { Toaster } from 'sonner'
import { Providers } from '@/providers/WagmiProvider'
import { FarcasterProvider } from '@/providers/FarcasterProvider'
import { Nav } from '@/components/Nav'
import { SiteFooter } from '@/components/SiteFooter'
import { TelemetryProvider } from '@/components/TelemetryProvider'
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
  // Search-engine ownership verification. Populate GOOGLE_SITE_VERIFICATION
  // (Google Search Console) and/or BING_SITE_VERIFICATION (Bing Webmaster
  // Tools) with the token each console gives you; Next renders the matching
  // <meta> into <head>. Bing coverage matters beyond Bing itself — it's the
  // index ChatGPT draws most of its citations from. Inert until set: an
  // undefined env var omits the tag entirely. See SEO.md for the full setup +
  // sitemap-submission checklist.
  verification: {
    google: process.env.GOOGLE_SITE_VERIFICATION,
    other: process.env.BING_SITE_VERIFICATION
      ? { 'msvalidate.01': process.env.BING_SITE_VERIFICATION }
      : undefined,
  },
  // Farcaster Mini App embed for the homepage. When the apex URL is
  // shared in a cast, this is the rich card that renders + launches the
  // Mini App. Per-route embeds (moment, collection, profile) are added
  // in their own generateMetadata in Phase 4. Also carries the Base.dev
  // app verification tag — base.dev fetches the apex HTML and confirms
  // the `base:app_id` matches the registered app to grant domain
  // ownership.
  other: {
    ...buildFarcasterEmbed({
      imageUrl:
        process.env.NEXT_PUBLIC_FARCASTER_EMBED_IMAGE_URL ?? `${SITE_URL}/embed-default.png`,
      buttonTitle: process.env.NEXT_PUBLIC_FARCASTER_BUTTON_TITLE ?? 'Enjoy Kismet',
      action: {
        url: SITE_URL,
        splashImageUrl:
          process.env.NEXT_PUBLIC_FARCASTER_SPLASH_URL ?? `${SITE_URL}/splash.png`,
        splashBackgroundColor: process.env.NEXT_PUBLIC_FARCASTER_SPLASH_BG ?? '#ffffff',
      },
    }),
    'base:app_id': '6a20aeab12545704b821bcc0',
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
        {/* Warm TLS to arweave.net. The dominant consumers are the
            inline <video> elements and the poster
            <img>s in MomentImage — both no-cors by default. Browser
            connection pools partition by CORS mode, so a crossorigin
            preconnect here would warm the wrong pool entry and the
            no-cors video/image requests would open a fresh connection
            anyway. dns-prefetch covers the AR.IO + IPFS pool we walk
            through on proxy failure. */}
        <link rel="preconnect" href="https://arweave.net" />
        {/* Quick Auth token acquisition runs on every Mini App reload.
            crossorigin matches the cors-mode fetch the @farcaster/quick-auth
            SDK issues for /nonce — without it the preconnect's pool entry
            sits unused and the SDK opens a fresh TCP+TLS connection
            anyway. */}
        <link rel="preconnect" href="https://auth.farcaster.xyz" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://permagate.io" />
        <link rel="dns-prefetch" href="https://ipfs.io" />
        <link rel="dns-prefetch" href="https://dweb.link" />
      </head>
      <body>
        <Providers>
          <FarcasterProvider>
            <TelemetryProvider />
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
                playing as the detail opens above. */}
            {modal}
            {/* Server-rendered footer: site-wide crawlable links (initial
                HTML) to /learn and the core surfaces. Sits below page
                content — including under the infinite feed on the homepage. */}
            <SiteFooter />
            <Toaster
              position="bottom-center"
              offset={{ bottom: 16 }}
              theme="dark"
              duration={3000}
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
