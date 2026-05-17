import { createRequire } from 'module'

const require = createRequire(import.meta.url)

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a self-contained `.next/standalone/server.js` plus a traced
  // minimal node_modules tree. Cuts the Docker runtime image from
  // ~700MB (full node_modules) to ~200MB, and lets us run `node
  // server.js` directly so SIGTERM reaches Node for graceful shutdown.
  output: 'standalone',

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
