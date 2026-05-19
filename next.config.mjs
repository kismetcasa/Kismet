import { createRequire } from 'module'

const require = createRequire(import.meta.url)

// Baseline security headers applied to every response. Deliberately
// excludes X-Frame-Options / CSP frame-ancestors — Kismet runs as a
// Farcaster Mini App inside Warpcast's webview, and a blanket frame
// deny would break that embed. Clickjacking protection for a Mini App
// requires an allowlisted frame-ancestors list, which is brittle as
// new Farcaster clients ship; defer to its own focused change.
// CSP is also intentionally omitted: RainbowKit / WalletConnect inject
// inline styles and connect to a wide pool of RPC + walletconnect
// relays, and our AR.IO + IPFS gateway pool rotates hosts on 404.
const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }]
  },

  // Emit a self-contained `.next/standalone/server.js` plus a traced
  // minimal node_modules tree. Cuts the Docker runtime image from
  // ~700MB (full node_modules) to ~200MB, and lets us run `node
  // server.js` directly so SIGTERM reaches Node for graceful shutdown.
  output: 'standalone',

  // Skip lint + type check in the Docker build — they OOM on a
  // resource-constrained Coolify builder once sharp's type definitions
  // are loaded. Caught locally via `npm run check` before merge.
  // (See package.json scripts.)
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },

  // Keep Node.js Turbo SDK external so /api/upload and /api/sign run natively
  serverExternalPackages: ['@ardrive/turbo-sdk'],

  images: {
    // Mirror the AR.IO + IPFS gateway pool in lib/arweave/gateways.ts so
    // MomentImage can fall through to alternates when one edge has a stale
    // 404 (e.g. CDN77 in front of arweave.net during the propagation window).
    // Wildcards cover subdomain redirects (`<txid>.arweave.net` style).
    remotePatterns: [
      { protocol: 'https', hostname: 'arweave.net' },
      { protocol: 'https', hostname: '*.arweave.net' },
      { protocol: 'https', hostname: 'permagate.io' },
      { protocol: 'https', hostname: '*.permagate.io' },
      { protocol: 'https', hostname: 'g8way.io' },
      { protocol: 'https', hostname: '*.g8way.io' },
      { protocol: 'https', hostname: 'ar-io.dev' },
      { protocol: 'https', hostname: '*.ar-io.dev' },
      { protocol: 'https', hostname: 'ipfs.io' },
      { protocol: 'https', hostname: '*.ipfs.io' },
      { protocol: 'https', hostname: 'dweb.link' },
      { protocol: 'https', hostname: '*.dweb.link' },
    ],
    // Arweave + IPFS are content-addressed (URL contains a hash), so the
    // bytes at any given URL never change — safe to cache aggressively.
    // 31 days is the max for next/image. After the first load, subsequent
    // views of any moment image are served from the on-disk image cache
    // instead of round-tripping back to Arweave.
    minimumCacheTTL: 60 * 60 * 24 * 31,
    // Cap the on-disk optimizer cache at 5 GB. Self-hosted on Oracle (200 GB
    // disk) the default unbounded cache would grow forever — each unique
    // (src, width, format) tuple writes a file, and with our gateway pool +
    // AVIF/WebP variants per breakpoint the multiplier is large. Past the
    // cap Next.js LRU-evicts the least-recently-served entries; recompute
    // cost is bounded because content-addressed bytes still come from the
    // upstream HTTP cache.
    maximumDiskCacheSize: 1024 * 1024 * 1024 * 5,
    // AVIF/WebP cut payload by 20-40% on browsers that support them.
    formats: ['image/avif', 'image/webp'],
  },

  // Browser polyfills for @ardrive/turbo-sdk/web in dev (turbopack)
  turbopack: {
    resolveAlias: {
      buffer: 'buffer/',
      crypto: 'crypto-browserify',
      stream: 'stream-browserify',
      process: 'process/browser',
    },
  },

  webpack: (config, { isServer, webpack }) => {
    config.resolve.alias['pino-pretty'] = false
    config.resolve.alias['@react-native-async-storage/async-storage'] = false

    if (!isServer) {
      // Strip node: URI prefix so standard fallbacks can resolve the modules
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
          resource.request = resource.request.replace(/^node:/, '')
        }),
      )

      // Browser polyfills for @ardrive/turbo-sdk/web
      config.resolve.fallback = {
        ...config.resolve.fallback,
        buffer: require.resolve('buffer/'),
        crypto: require.resolve('crypto-browserify'),
        stream: require.resolve('stream-browserify'),
        process: require.resolve('process/browser'),
      }
    }
    return config
  },
}

export default nextConfig
