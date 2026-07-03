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
# Minor-pinned base (not bare `node:22-alpine`): Node's DEFAULT V8 heap sizing
# is undocumented and has CHANGED across 22.x releases (measured: ~2 GB default
# on the build that OOM'd prod at ~2030 MB; ~8 GB default on node 22.22 on a
# 15.7 GB host). An unpinned tag lets runtime memory behavior drift between
# rebuilds. Keep all three stages on the same pin.
FROM node:22.22-alpine AS deps
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
FROM node:22.22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Re-populate public/ffmpeg-core/ — the deps stage created it before
# source was overlaid, and `COPY . .` would have shadowed it with the
# (intentionally-empty, gitignored) source-tree version. The script is
# idempotent and copies two small files.
RUN node scripts/copy-ffmpeg-core.mjs

ENV NEXT_TELEMETRY_DISABLED=1
# Bound the V8 heap so `next build` stays under the Coolify host's
# available RAM and isn't reaped by the kernel OOM-killer mid-compile.
# That failure mode is an abrupt SIGKILL with NO V8 "heap out of memory"
# message — `next build` dies right at "Creating an optimized production
# build" and the deploy reports a bare non-zero exit (see the 2026 deploy
# post-mortem). Type-check/lint are already disabled in next.config, so
# this heap covers webpack/SWC compilation only. Measured cold-build peak
# node RSS: ~4.1 GB at 4096, ~3.5 GB at 3072 — both build cleanly, so 3072
# buys ~640 MB of headroom for the out-of-heap SWC Rust workers + the OS
# on a constrained host. If it still OOMs, the host needs more RAM/swap.
ENV NODE_OPTIONS="--max-old-space-size=3072"
RUN npm run build

# ─── runtime stage ───────────────────────────────────────────────────
# Final image. Only the standalone bundle + static + public assets +
# the cache dir Coolify mounts a volume onto.
FROM node:22.22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Bind on all interfaces so the container is reachable from Coolify's
# port mapper. PORT is overridable at deploy time by Coolify.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# ─── Runtime V8 heap cap (keep this flag — never rely on defaults) ────
# Production was crashing every ~45 min with `FATAL ERROR: ... JavaScript heap
# out of memory` at ~2030 MB — a V8 HEAP OOM (not a kernel/cgroup OOM, so
# Docker's OOMKilled stayed false and `dmesg` was clean, which masked it). That
# build's Node sized the default old-space at ~2 GB on the 11 GB host (no
# cgroup limit set).
#
# The default heap is UNDOCUMENTED and version-dependent — measured ~2 GB on
# the build that crashed vs ~8 GB default on node 22.22 (15.7 GB host) — so the
# explicit flag is the only version-stable behavior; hence the pinned base
# image above. 4096 MB leaves headroom under an 11 GB host even alongside a
# concurrent `next build` (~3.5 GB). A Coolify runtime NODE_OPTIONS env var
# overrides this ENV without a rebuild.
#
# Setting a Coolify container --memory limit is ALSO recommended (host
# protection + OOMKilled=true observability) but it is NOT a substitute for
# this flag: auto-derived heaps vary by Node version (~50%-of-limit heuristics,
# historical 2 GB caps) and can come out LOWER than 4096, reintroducing the
# crash. Size flag ≈ ⅔–¾ of the container limit (4096 with a 6 GB limit) so
# off-heap allocations (undici, sharp, ffmpeg, /api/img) fit underneath. The
# growth drivers are bounded in code (timeline MERGE_BUDGET, bounded /api/img
# reads, patched next clone-response — scripts/patch-next-clone-response.mjs);
# this cap is the backstop, those bounds stop the climb.
ENV NODE_OPTIONS="--max-old-space-size=4096"

# ffmpeg powers the server-side GIF→MP4 transcode (/api/transcode-gif),
# the no-wasm-cap fallback for GIFs too large for the in-browser path.
# Static Alpine package, no extra runtime deps; the route shells out to
# the binary via child_process.
RUN apk add --no-cache ffmpeg

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
