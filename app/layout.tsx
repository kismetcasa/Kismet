import type { Metadata } from 'next'
import { Toaster } from 'sonner'
import { Providers } from '@/providers/WagmiProvider'
import { Nav } from '@/components/Nav'
import './globals.css'

export const metadata: Metadata = {
  title: 'Kismet Art',
  description: 'mint, collect, and discover art on Kismet Art',
  openGraph: {
    title: 'Kismet Art',
    description: 'mint, collect, and discover art on Kismet Art',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
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
