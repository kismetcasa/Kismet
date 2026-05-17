# syntax=docker/dockerfile:1.7

# Multi-stage build for the inprocess-client Next.js app.
#
# Layout:
#   deps    → resolve node_modules + run postinstall (copies ffmpeg-core
#             wasm into public/ffmpeg-core/)
#   builder → run `next build` with output: 'standalone' (see next.config.mjs)
#   runner  → minimal runtime: standalone server.js + static + public
#
# The runtime image runs as non-root and execs Node directly so signals
# reach the process for graceful shutdown.

# ─── deps stage ──────────────────────────────────────────────────────
# Resolve dependencies in isolation so a source-only change reuses this
# layer. We need `scripts/` present here because package.json's
# postinstall hook (copy-ffmpeg-core.mjs) runs as part of `npm ci`.
FROM node:20-alpine AS deps
WORKDIR /app

# Build toolchain for native modules. `bufferutil` (transitive via ws →
# wagmi/walletconnect) ships prebuilt binaries for most targets but NOT
# for linux-musl-arm64 (Alpine on ARM, i.e. Oracle Ampere), so npm has
# to compile it from source. These packages stay in the deps stage and
# never reach the runtime image.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund

# ─── builder stage ───────────────────────────────────────────────────
# Bring in deps, overlay source, re-run the postinstall (deps stage's
# public/ffmpeg-core/ is dropped by the source COPY above), then build.
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Re-populate public/ffmpeg-core/ — the deps stage created it before
# source was overlaid, and `COPY . .` would have shadowed it with the
# (intentionally-empty, gitignored) source-tree version. The script is
# idempotent and copies two small files.
RUN node scripts/copy-ffmpeg-core.mjs

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ─── runtime stage ───────────────────────────────────────────────────
# Final image. Only the standalone bundle + static + public assets +
# the cache dir Coolify mounts a volume onto.
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Bind on all interfaces so the container is reachable from Coolify's
# port mapper. PORT is overridable at deploy time by Coolify.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Non-root runtime user (security baseline; some host kernels' seccomp
# profiles also require it).
RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs

# Standalone output: server.js entry + traced minimal node_modules.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# .next/static and public/ are URL-served at runtime, not traced into
# standalone — copy them explicitly.
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Pre-create .next/cache with the right owner so Coolify's persistent
# volume mount works without permission errors at first write. Without
# this, the host volume is owned by root, the nextjs user can't write,
# and every ISR write fails silently.
RUN mkdir -p ./.next/cache && chown -R nextjs:nodejs ./.next/cache

USER nextjs
EXPOSE 3000

# Self-documenting healthcheck for plain `docker run` / Docker Swarm
# usage. Coolify configures its own probes against /api/health and
# /api/readiness via service settings (see deploy notes). Uses Node's
# built-in fetch so we don't need curl in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec node directly so SIGTERM reaches it. An sh/npm wrapper would
# swallow the signal and force Coolify to SIGKILL after the grace
# period, dropping in-flight requests.
CMD ["node", "server.js"]
