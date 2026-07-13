import { createRequire } from 'module'

const require = createRequire(import.meta.url)

// Baseline security headers applied to every response.
//
// CSP ships in REPORT-ONLY mode: it BLOCKS NOTHING — browsers only report
// violations — so it's a zero-risk way to discover exactly what an enforcing
// policy must allow before flipping it on. Enforcing CSP is genuinely hard here
// (RainbowKit / WalletConnect inject inline styles and connect to a rotating
// pool of RPC + WalletConnect relays; our AR.IO + IPFS gateway pool rotates
// hosts), and `frame-ancestors` must allowlist every Farcaster host that embeds
// the Mini App (Warpcast, Base, third-party clients) or the embed breaks —
// which is exactly why we discover the real set in report-only first.
// FOLLOW-UP to actually close the clickjacking / XSS-defense-in-depth gap:
// review reported violations, tighten these directives, wire a report
// collector, then promote to the enforcing `Content-Security-Policy` header
// (drop `-Report-Only`). Report-only is step 1 of 2 — it does not itself block.
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "worker-src 'self' blob:",
  "frame-src 'self' https:",
  "frame-ancestors 'self' https://warpcast.com https://*.warpcast.com https://farcaster.xyz https://*.farcaster.xyz https://base.org https://*.base.org",
].join('; ')

const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Content-Security-Policy-Report-Only', value: CSP_REPORT_ONLY },
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

  // Two knobs that bound peak build RSS on the same constrained host.
  // The SWC parallel workers live OUTSIDE V8's heap (they're Rust
  // processes that fork during minification) so NODE_OPTIONS
  // --max-old-space-size doesn't bound them — on a 4-CPU host the
  // default 4 workers each held ~600-900 MB of Rust-side memory and
  // the cgroup OOM-killer was reaching `next build` before V8 ever
  // noticed. `cpus: 1` runs a single worker (the biggest peak-RAM cut;
  // dropped from 2 after the build crept up to the OOM threshold and
  // started SIGKILLing on deploy); `webpackMemoryOptimizations` drops
  // webpack's intermediate caches during compilation for another
  // 15-30% reduction. Together they trade build wall-time for headroom
  // against SIGKILL. If the build still OOMs, the host needs more
  // RAM/swap — the V8 heap alone is capped at 3 GB (Dockerfile).
  experimental: {
    cpus: 1,
    webpackMemoryOptimizations: true,
  },

  // Keep Node.js Turbo SDK external so /api/upload and /api/sign run natively
  serverExternalPackages: ['@ardrive/turbo-sdk'],

  images: {
    // Allowlist for the AR.IO + IPFS gateways lib/arweave/gateways.ts can emit;
    // keep it in sync with that pool. The Arweave side is currently a single
    // host (arweave.net) with no alternate to fall through to; the IPFS side
    // keeps alternates so MomentImage can route around a stale-404 edge. Re-add
    // an AR.IO host here whenever one is added back to the pool. Wildcards cover
    // subdomain redirects (`<txid>.arweave.net` style).
    remotePatterns: [
      { protocol: 'https', hostname: 'arweave.net' },
      { protocol: 'https', hostname: '*.arweave.net' },
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
