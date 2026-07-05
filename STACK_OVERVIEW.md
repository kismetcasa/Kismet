# Kismet — Complete Stack Overview

_A component-by-component map of every protocol and piece of infrastructure Kismet
touches, how they fit together, and why each exists — validated against the code
(`file:line`) and the repository's commit history._

> **What Kismet is.** An onchain NFT-social app (package name `inprocess-client`)
> for creating, collecting, and reselling "moments" (Zora 1155 tokens) on **Base
> mainnet**. It is a Next.js 15 / React 19 front-end and thin server over the
> **inprocess.world** backend, distributed primarily through **Farcaster / Base
> Mini App** hosts, self-hosted as a **single Docker container** on an Oracle
> Ampere box via Coolify/Traefik. It has **no SQL database** — Upstash Redis is
> the only persistent store.
>
> **How this was produced.** A full multi-agent read of `app/`, `lib/`, `hooks/`,
> `providers/`, `contexts/`, `scripts/`, the Dockerfile/next.config/env template,
> and the in-repo runbooks, cross-checked against `git log`/`git show` over the
> repository's history (a shallow clone of ~346 commits, oldest ~2026-06-12). Where
> a subsystem's genesis predates the shallow boundary it is noted; the merge
> `1160af1` (PR #476, 2026-06-23) is the graft point where much of the codebase
> first becomes visible, so for many files "first commit" means "entered the clone
> here", not "was written here". The unusually detailed commit messages are mined
> as the authoritative design record where granular history is unavailable.

**Companion docs already in the repo:** `SCALING_AUDIT.md` (scale cliffs),
`AVAILABILITY_RUNBOOK.md` (single-container uptime), `REMEDIATION_PLAYBOOK.md`
(source-verified fixes), `CDN_RUNBOOK.md` (Cloudflare fronting), `VIDEO_PLAYBACK_RCA.md`
(the iOS range-contract incident). This document is the architectural *map*; those
are the operational *verdicts*.

---

## 0. TL;DR — the whole stack in one picture

```
                            ┌──────────────────────────── Farcaster / Base App host ───────────────────────────┐
                            │  Mini App SDK · Quick Auth JWT · webhook (push) · cast embeds · host wallet        │
                            └───────────────┬─────────────────────────────────────────────────────────────────┘
  Browser (desktop/mobile web) ─────────────┤
   wagmi/viem · RainbowKit · WalletConnect   │  ffmpeg.wasm · thumbhash · InlineVideo
                                             ▼
   ┌───────────────────────────── Next.js 15 (standalone) — ONE container ─────────────────────────────┐
   │  App Router pages + ~80 API routes + instrumentation boot + next/image optimizer                  │
   │                                                                                                   │
   │  Auth: SIWE cookie · FC Quick-Auth JWT · EIP-712 intent · admin/curator SIWE                      │
   │  Guards: IP rate-limit · per-identity day/week quota · SSRF (safeUrl) · blacklist · pass-gate     │
   └───────┬───────────┬────────────┬────────────┬───────────┬────────────┬──────────────┬────────────┘
           │           │            │            │           │            │              │
     Upstash Redis  Base RPC    inprocess.world  Arweave/    Coinbase     Alchemy       Chainlink
    (only datastore) (viem)     REST API +       ArDrive     CDP + Base    NFT-Activity  ETH/USD feed
     sessions/quotas Base 8453  ERC-4337 relay   Turbo       Spend Perms   webhook       (Base)
     caches/ledgers  Eth mainnet /transfers feed (permanent  (Agent        (Pass gate    (USD earnings)
     zsets/locks     (ENS)      /smartwallet     storage)    Collect)      provenance)
                                                    │
                             On-chain (Base 8453):  ▼
        Zora 1155 protocol · FixedPriceSaleStrategy · ERC20Minter · Zora factory · Multicall3 · USDC
        Seaport 1.5 (secondary market) · 0xSplits SplitMain · EIP-2981 royalties · ERC-8021 builder code
   ─────────────────────────────────────────────────────────────────────────────────────────────────
   Hosting: Oracle Ampere (ARM64) · Coolify · Traefik · Docker (node:22.22-alpine) · Vercel/Coolify cron
```

**The five load-bearing external dependencies** (any one down degrades the product):
Upstash Redis (all mutable state), inprocess.world (all content + gas-sponsored mint
relay), Base RPC (every on-chain read/verify), Arweave/Turbo (permanent media), and
the single Oracle container itself (zero redundancy).

---

## 1. Complete protocol & infrastructure inventory

Every external protocol, on-chain contract, managed service, and SDK the code
touches — with the concrete evidence.

### 1.1 Blockchains & RPC

| Chain | Purpose | Evidence |
|---|---|---|
| **Base mainnet** (chainId 8453) | Primary read/write chain — mints, collects, listings, permissions, spend permissions | `lib/rpc.ts` `serverBaseClient()`, `lib/wagmi.ts:133` |
| **Ethereum mainnet** (chainId 1) | ENS resolution only (client `useEnsName` + server) | `lib/ensCache.ts`, `lib/wagmi.ts:163-166` |

RPC keys are **split client/server**: `NEXT_PUBLIC_BASE_RPC_URL` (inlined in the
browser bundle, must be origin-restricted at the provider) vs server-only
`BASE_RPC_URL` (paid key, never bundled); same pattern for mainnet ENS. Public
fallbacks (`mainnet.base.org`, viem's default) rate-limit under load.

### 1.2 On-chain protocols & contracts (Base)

| Contract / standard | Address (or standard) | Used for | Evidence |
|---|---|---|---|
| Zora 1155 FixedPriceSaleStrategy (inprocess variant) | `0x2994762aA0E4C750c51f333C10d81961faEBE785` | ETH primary mints | `lib/zoraMint.ts:31` |
| Zora ERC20Minter | `0xE27d9Dc88dAB82ACa3ebC49895c663C6a0CfA014` | USDC primary mints | `lib/zoraMint.ts:32` |
| Zora 1155 factory | `0x777777E8850d8D6d98De2B5f64fae401F96eFF31` (`lib/zoraMint`) / `0x540C18B7f99b3b599c6FeB99964498931c211858` (`lib/collections.ts:12`) | Collection deploy | `lib/collections.ts:12` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | ETH collect-all batching (`aggregate3Value`) | `lib/zoraMint.ts:141` |
| USDC (Base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | USDC sale currency | `lib/zoraMint.ts:35` |
| **Seaport 1.5** | `0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC` (EIP-712 domain `version: '1.5'`) | Secondary marketplace settlement | `lib/seaport.ts:11,93` |
| 0xSplits SplitMain | deployed/managed by inprocess | Revenue splits (creator-reward recipient) | `lib/splits.ts`, `app/api/distribute` |
| EIP-2981 | per-collection `royaltyInfo` | Secondary royalties | `lib/seaport.ts` |
| Chainlink ETH/USD feed | `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` (override `CHAINLINK_ETH_USD_FEED`) | USD earnings view (`latestRoundData`) | `lib/ethPrice.ts:6-7` |
| Base Spend Permissions | SpendPermissionManager (via `@base-org/account`) | Agent Collect budgets | `lib/agent/scout/grantBudget.ts` |
| ERC-4337 account abstraction | CDP smart account userOps | Autonomous collect execution | `lib/agent/scout/spender.ts` |
| ERC-8021 Base Builder Code | marker `0x80218021…`, code `bc_p876wb1c` | Onchain attribution suffix on every write | `lib/builderCode.ts` |

**Platform-owned on-chain addresses** (config constants, all with baked-in
production defaults in `lib/config.ts`):

| Constant | Address | Role |
|---|---|---|
| `PLATFORM_COLLECTION` | `0x349D3DA472BDD2FBeebf8e0bBAF4220160A62526` | Kismet Casa admin-mint collection; Discover filter |
| `CREATE_REFERRAL` / `KISMET_REFERRAL` | `0xc6021D9F09e145a6297f64551aa2eCA6d66F8f75` | Zora create/mint-referral treasury (**treasury-critical**) |
| `RESIDENCIES_ADDRESS` | `0x58f19e55058057B04feAe2EEA88F90B84b7714Eb` | Kismet Casa residencies cut (default 5%) |
| `PLATFORM_FEE_RECIPIENT` | `0x099B9BBe0937428e145a3003dDf58e7E0CF69801` | 1% secondary fee (`PLATFORM_FEE_BPS = 100n`, **treasury-critical**) |
| Pass/Patron collection | `0x80ce7bd430f34792490a22ee0fd479e7333715c9` | Token-gate Pass (admin-configurable) |
| `ADMIN_ADDRESS` / `CURATOR_ADDRESSES` default | `0x3D140B892437dD7857701098415deB2daaE03A40` | Admin + curator (self-seeded default) |
| `OPERATOR_SMART_WALLET` | env-set | Platform CDP wallet for admin-mint/airdrop routing |

### 1.3 Managed third-party services

| Service | Role | Auth | Evidence |
|---|---|---|---|
| **Upstash Redis** (REST) | The *only* persistent datastore | `UPSTASH_REDIS_REST_URL/TOKEN` | `lib/redis.ts` |
| **inprocess.world** (`api.inprocess.world`) | Content indexer + ERC-4337 gas-sponsored mint/distribute relay + `/smartwallet` + `/transfers` earnings feed | `INPROCESS_API_KEY` (writes only; reads keyless) | `lib/inprocess.ts:4` |
| **ArDrive Turbo** (`upload.ardrive.io`, `payment.ardrive.io`) | Permanent Arweave storage (bundling + optimistic cache) | server-side `ARWEAVE_JWK` (signing proxy) | `lib/arweave/*` |
| **Coinbase CDP** (`api.developer.coinbase.com`) | Server-wallet smart account ("scout spender") + ERC-7677 paymaster | `CDP_API_KEY_ID/SECRET/WALLET_SECRET` | `lib/agent/scout/spender.ts` |
| **Alchemy** | NFT-Activity webhook → Pass-transfer provenance gate | HMAC-SHA256 `ALCHEMY_WEBHOOK_SIGNING_KEY` | `app/api/webhooks/pass-transfer/route.ts` |
| **Farcaster** (`api.farcaster.xyz`, `auth.farcaster.xyz`, `hub.farcaster.xyz`) | Mini App identity, Quick-Auth JWT, profile/verifications, webhook app-key verify, native push | keyless reads; JWKS/Hub verify | `lib/farcasterAuth.ts`, `lib/farcasterProfile.ts` |
| **WalletConnect Cloud** | WalletConnect wallet option (via RainbowKit) | `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | `lib/wagmi.ts` |
| **Base MCP** (`mcp.base.org`) | External AI-agent runtime consuming the Agent Actions API | n/a (agent-side) | `public/agent-skill/SKILL.md` |
| **Cloudflare** | Edge (client-IP trust `cf-connecting-ip`; proposed CDN for `/api/img`) | n/a | `lib/ratelimit.ts:5`, `CDN_RUNBOOK.md` |

### 1.4 Storage, media & content delivery

- **Arweave gateways** — `lib/arweave/gateways.ts:19-21`: pool is now **`arweave.net` alone** (`g8way.io`, `ar-io.dev`, `permagate.io`, `arweave.dev` all pruned May–June 2026 as they died). **IPFS gateways**: `ipfs.io`, `dweb.link`.
- **next/image optimizer** — AVIF/WebP, 31-day TTL, on-disk cache LRU-capped at 5 GB (`next.config.mjs:60-91`).
- **FFmpeg** — `@ffmpeg/core` wasm (in-browser GIF→MP4, self-hosted at `public/ffmpeg-core/`) + system `ffmpeg` binary in the runtime image (server GIF→MP4 fallback). **sharp** (image resize/palette). **thumbhash** (~25-byte placeholders).
- **`/api/img`** — the byte-range-owning gateway proxy that races the pool, synthesizes RFC-9110 `206`s, learns exact totals, and sharp-downscales oversized sources.

### 1.5 Hosting, build & runtime infrastructure

| Piece | Detail | Evidence |
|---|---|---|
| Compute | Single **Oracle Ampere** (ARM64) VM, ~11 GB RAM, 200 GB disk — **zero redundancy** | `AVAILABILITY_RUNBOOK.md` |
| Orchestrator | **Coolify** (build, env injection, volume mount on `.next/cache`, health probes) | `AVAILABILITY_RUNBOOK.md` |
| Ingress | **Traefik** reverse proxy (`502` = node died; "no server available" = zero healthy backends) | `AVAILABILITY_RUNBOOK.md` |
| Container | **Docker** multi-stage (deps→builder→runner), **`node:22.22-alpine` pinned** on all stages, non-root uid 1001, execs `node server.js` directly for SIGTERM | `Dockerfile` |
| Framework | **Next.js 15.5.19** `output: 'standalone'`, App Router, instrumentation hook | `next.config.mjs`, `package.json` |
| Memory | V8 heap caps: **build 3072 MB / runtime 4096 MB** (fixes a masked V8-heap OOM at ~2030 MB) | `Dockerfile:62,101` |
| Cron | `vercel.json` declares hourly `/api/cron/sync-stats`; on Coolify fired by an external scheduler (`CRON_SECRET`) | `vercel.json` |
| CI | GitHub Actions: `npm ci` → assert clone-response patch → `next build` → `npm run check` → blocking critical `npm audit`; Dependabot weekly | `.github/workflows/ci.yml` |

### 1.6 The full environment-variable surface

`.env.example` documents ~40 vars with rationale. The subsystems that read them and
what breaks if unset are covered per-component in §3. **Note (drift):** four vars are
read in code but **missing from `.env.example`** — see §6.

---

## 2. Architecture: how it all fits together

Kismet is best understood as **eight layers**, each of which is a review unit in §3:

1. **Blockchain & wallet** — connect a wallet across three surfaces (web, Farcaster iframe, Base App WebView), read/write Base, resolve smart accounts.
2. **On-chain protocols** — Zora minting, Seaport secondary market, 0xSplits/royalties/fees.
3. **External backend** — inprocess.world is the content indexer *and* the gas-sponsored mint relay; Kismet has no content store of its own.
4. **Storage & media** — Arweave/Turbo for permanence; a heavy client+server media pipeline to make onchain art actually play on iOS/WebKit and inside Mini Apps.
5. **Identity & social** — Farcaster Mini App, three auth paths, ENS/FC identity unification, notifications.
6. **Data & platform infra** — Upstash Redis (the whole datastore), rate-limit/quota/abuse guards, telemetry/health, config, Next.js/Docker/Coolify.
7. **Product subsystems** — Agent Collect (autonomous), Pass gate (provenance), airdrops, feeds/curation/stats, moments/collections domain.

**Two invariants that thread through everything:**

- **The three-smart-wallet separation** (never conflated in code): (a) the Kismet-controlled **CDP "scout spender"** that draws users' Spend Permissions; (b) each creator's **per-creator inprocess smart wallet** that holds Zora ADMIN and executes `/moment/create`; (c) the **operator smart wallet** for admin-mint/airdrop routing. A live collection mints with `permissions(0, operator) = 0` — misreading this repeatedly misdirected debugging (`29660ed`).
- **Redis is the single datastore and a coordination primitive.** No SQL. Every session, quota, ledger, feed index, lock, and cache lives in Upstash. Two structural pressures — per-command billing (~1M/mo vs a 500K free cap) and single-container availability — shape most of the hardening you see.

**The recurring theme across the whole codebase is "scar tissue":** an unusually
large fraction of the code is a documented, source-verified response to a specific
production incident (a Base sequencer halt, a V8-heap OOM, an iOS AVFoundation range
rejection, an Upstash string-vs-number flag bug, an inprocess API-param drift, an
Arweave credit-drain). The commit messages read like post-mortems, and the design
is overwhelmingly reactive-and-hardened rather than speculative.

---

## 3. Component-by-component review

Each component: **what it is → why it exists (functional need + history) → key
mechanisms → risks/constraints.** Grouped by layer. Contract addresses and
`file:line` anchors are validated against the working tree.

### Layer A — Blockchain & wallet

#### A1. EVM wallet & RPC layer (`wallet-rpc`)
**What.** The entire wallet-connection and chain-read substrate: a hand-built wagmi
`createConfig` over `[base, mainnet]`, environment-gated connectors, split
client/server RPC transports with Multicall3 batching, chain-stall detection, and
multi-layer keepalive/recovery. Anchors: `lib/wagmi.ts`, `lib/rpc.ts`,
`providers/WagmiProvider.tsx`, `lib/chainHealth.ts`, `hooks/useEnsureConnected.ts`,
`hooks/useWalletConnectKeepalive.ts`, `hooks/useWalletRecovery.ts`.

**Why.** Kismet must let users sign Base transactions across a normal browser, a
Farcaster Mini App host (iframe on web, React-Native WebView on mobile), and the
Coinbase/Base App in-app browser — three surfaces with very different connector
behavior. The design is reactive to field-verified failures: a dead Mini App
postMessage bridge pinning wagmi's serial reconnect (the **1.5 s time-bounded
connector** that races only `eth_accounts`/`eth_requestAccounts`/`eth_chainId`),
Coinbase WebViews not being EIP-6963-discoverable (the `injected()` connector +
auto-connect), and iOS Safari suspending WebSockets so wagmi lies about
`isConnected` (the visibility-triggered WalletConnect relay ping + `restartTransport`).
The whole client wallet layer lands at `1160af1`; `a7a8e14` (2026-06-25) added
**chain-stall detection** after the real Jun-25 Base halt at block 47806542 (during
a stall, reads succeed but writes fail, so a single `getBlockNumber` looks healthy —
only two reads ~4 s apart detect it).

**Key mechanisms.** Client-vs-server RPC key separation to keep the paid key out of
the browser bundle; `client()` factory (not `transports`) to enable Multicall3
batching; readiness treats Base RPC as **non-gating** (`degraded` only) so an RPC
blip can't evict the single pod.

**Risks.** `NEXT_PUBLIC_*` RPC keys ship to every browser (restrict by origin);
public fallbacks rate-limit; `useWalletConnectKeepalive` reaches into private-ish WC
internals (degrades to no-op on rename; `useWalletRecovery` is the backstop).

#### A2. Coinbase CDP, Base Account & smart-wallet resolution (`cdp-smartwallet`)
**What.** Three separately-owned smart-account rails: the CDP "scout spender"
(atomic gasless ERC-4337 userOps for autonomous collect), per-creator inprocess
smart wallets (resolved over HTTP with durable caching), and the operator wallet.
Anchors: `lib/resolveSmartWallet.ts`, `lib/smartWalletPreflight.ts`,
`lib/agent/scout/spender.ts`, `scripts/bootstrap-spender.ts`.

**Why.** Two needs converged: (a) Agent Collect needs a server-controlled on-chain
identity to hold the spender role and submit spend()+mint atomically without funds
resting in custody — solved by a CDP Server-Wallet smart account (deterministic by
name, gasless via ERC-7677 paymaster); (b) inprocess executes `/moment/create` as
the creator's **own** per-creator smart wallet, obtainable **only** via the live
`GET /smartwallet` endpoint (no counterfactual derivation), so an outage of that
endpoint simultaneously broke deploy-time ADMIN grants, the mint preflight, and the
authorize banner. The git history is dominated by hardening that fragility:
`c40cac7` (wrong `artist_wallet` param → 400), `6e5cdcd` (a bogus `x-api-key` on a
public read → 500), `3550ab3` (durable Redis cache restoring the fixed-address
design's robustness), `8fda3a4` (split `notFound` from transient), `17f45ee`
(un-mask the boot drift-detector; records the audit that **Agent Collect is
architecturally independent** of the inprocess smart wallet).

**Key mechanisms.** Fail-fast assertion that the CDP-derived address equals
`NEXT_PUBLIC_SCOUT_SPENDER_ADDRESS`; a cross-instance Redis **spender mutex**
(`serialized()`, 240 s TTL) because CDP smart accounts require sequential userOps;
transient-vs-`notFound` discrimination threaded end-to-end; 30-day durable
EOA→smart-wallet cache with reverse index; `skipCache` mode so the boot drift
detector can't be masked by the cache it enables.

**Risks.** Single shared spender is a serialization bottleneck; spender-address
misconfig is fatal-by-design (and `NEXT_PUBLIC_` requires a rebuild to change);
paymaster loss hard-fails every collect (spender holds no ETH); the per-creator
wallet has no local derivation so a brand-new creator during an inprocess outage
still fails.

### Layer B — On-chain protocols

#### B1. Zora minting protocol & mint flow (`zora-mint`)
**What.** Three interlocking mint surfaces: pure on-chain calldata builders
(`lib/zoraMint.ts` — the single source of truth for every value-carrying mint), the
server-relayed moment mint through inprocess (`lib/mint-proxy.ts`), and direct
factory collection deploys from the user's own wallet
(`components/CreateCollectionForm.tsx`, `lib/collections.ts`).

**Why.** Kismet is a social front-end over the Zora 1155 protocol and the inprocess
relay — this is its revenue-and-minting core. `KISMET_REFERRAL`/`CREATE_REFERRAL`
are the platform's Zora reward sinks (treasury-critical; the server unconditionally
overwrites client-supplied `createReferral` so a form-bypasser can't steal it).
History: `29660ed`/`8fda3a4` proved on-chain that mints execute as the creator's
per-creator smart wallet (stranding accounts without one, hence the
`NO_ACCOUNT`/`AUTHORIZE_REQUIRED` preflights); `9e505eb` added `findLandedDeploy`
after Base Account request-TTLs expiring post-broadcast duplicated collections;
`2fb975d` reshaped inprocess's opaque `{error:'Error'}` responses; `48eb465` added
the `saleEnds` zset for the Ending-Soon feed.

**Key mechanisms.** `value = (mintFee + price) * qty` with FPSS strict-equality
(wrong value reverts, never overpays); `mintToCreatorCount:1` forces `saleStart=0`
(the setup copy mints *through* the strategy and would revert `SaleHasNotStarted` on
a future start); deploy `setupActions` grant ADMIN to the inprocess SW **and**
`OPERATOR_SMART_WALLET` so later relayed mints don't revert; chain-time-gated
eligibility fails closed on RPC error.

**Risks.** Treasury single-point-of-failure on the referral constants; hard
dependency on the inprocess relay for moment mints; strategy addresses are the
inprocess-specific FPSS/ERC20Minter, not canonical Zora deployments.

#### B2. Seaport secondary marketplace (`seaport-market`)
**What.** An off-chain (Redis) order book over **Seaport 1.5** on Base. Holders
sign gasless EIP-712 sell orders that inject a hardcoded **1% platform fee** and the
EIP-2981 royalty into the signed consideration; buyers fill on-chain; fills are
**receipt-anchored** (the server decodes the `OrderFulfilled` event, never trusts
the caller).

**Why.** So collectors can resell moments while creators keep their royalty and the
platform earns 1% — both enforced by baking them into the signed consideration, not
trusting the client. History: `99789dc` established receipt-anchored fills after a
webhook race could permanently deny Pass validity and any caller could mark a
listing sold; `588698c` added the 1% fee as consideration `[1]` (OpenSea canonical
`seller→fee→royalty` ordering); `5120692` hardened the empty-env recipient that had
500'd every listing; `3540238` fixed a concurrent-listing race with atomic `SET NX`;
`1b0d3b7` wired settled royalties into artist earnings.

**Key mechanisms.** Stored fee/royalty fields are **informational only** — all
financial truth comes from `orderComponents.consideration` and the decoded fill
event; server-side EIP-712 verification via viem `verifyTypedData` (ERC-1271/6492
smart-wallet support, 6492 wrapper stripped before storage); one shared dust-floor
predicate across web/agent/POST paths; currency baked into the signed hash so an ETH
order can't be filled with USDC.

**Risks.** `PLATFORM_FEE_RECIPIENT` treasury-critical (empty env falls back via
`?.trim()||`); feed scans only the newest 500 listings; off-chain cancel is soft (a
leaked signed order stays fillable until its 30-day expiry unless an on-chain
`cancel()` is sent).

#### B3. Splits, royalties & platform fees (`splits-royalties`)
**What.** Three coupled revenue mechanisms: primary splits (0xSplits SplitMain via
inprocess), the 1% Seaport fee, and royalty crediting/audit that decomposes a
collection-wide EIP-2981 royalty paid to a split contract back onto individual
artists' earnings cards.

**Why.** On-chain 0xSplits are correct but hostile to product surfaces (members
aren't efficiently enumerable), so the app mirrors recipient lists in Redis (+ a
per-recipient reverse index) to authorize distribution, render splits panels, and
decompose royalties. History: `9bf73ec` extracted the pure `splitsMath.ts` after a
"decimal 47.5" bug (a 50/50 split scaled by 0.95 for a 5% residencies cut) reverted
SplitMain setup on-chain; `2979f01` added the pending-earnings roll-up;
`2a1b6dc`→`24e8da9` instrumented-then-built royalty decomposition.

**Key mechanisms.** Largest-remainder integer allocation guaranteeing whole
percentages summing to exactly 100; two-layer validation (client + server
`validateSplitsArray`); distribute defense-in-depth (EIP-191 signed message,
role authz, on-chain `splitAddress` match, gas quota — because the *platform*
sponsors the tx); `verify-mint.ts` CI oracle pinning the math.

**Risks.** inprocess `/distribute` is **non-idempotent** (a timeout is
indeterminate → 502, never auto-retry, or it pays out twice); royalty decomposition
only covers splits Kismet minted and stored; the Redis mirror can drift from chain
(lazy self-heal, no bulk backfill).

### Layer C — External backend

#### C1. inprocess.world API integration (`inprocess-api`)
**What.** Kismet's entire backend — a Zora-on-Base indexer + ERC-4337 relay reached
at `https://api.inprocess.world/api`. **Reads** (`/timeline`, `/moment`,
`/collection(s)`, `/comments`, `/payments`, `/transfers`, `/smartwallet`) are
keyless with 8 s timeouts; **writes** (`/moment/create[/writing]`, `/distribute`,
`PATCH /moment`) carry `x-api-key: INPROCESS_API_KEY` and execute a gas-sponsored
userOp as the caller's per-creator smart wallet (45–60 s timeouts).

**Why.** Kismet has no content store — it stitches inprocess data with its own Redis
KV. The relay lets creators mint without paying gas (platform pays via the operator
wallet tied to the API key), which is exactly why every write path is wrapped in
signed-intent auth, token-gates, and per-user quotas. The `/transfers` feed is the
authoritative paid-sales record from which earnings are rebuilt. History: `6e5cdcd`
established the read-keyless/write-keyed split; `24e8da9` hardened `/transfers`
shape validation (a wrong-shaped 200 now aborts the scan instead of overwriting
every artist's totals with a truncated partial); `83767c1` treated inprocess as an
unreliable SPOF (bounded timeouts, strict shapes, observability); `1bf7b1b`
made `/distribute` treat timeouts as indeterminate.

**Key mechanisms.** The `proxyMintRequest` funnel (intent auth → gates → quota →
smart-wallet preflight → field sanitization → `createReferral` overwrite → forward →
`after()` side effects); durable two-layer smart-wallet cache; KV creator override
preferred over inprocess `momentAdmins` (which credit the platform SW for delegated
mints).

**Risks.** Hard SPOF for all content + the mint relay (no public SLA, gated docs);
shared API key spends platform gas so a leaked write endpoint costs the platform;
the `/moment/airdrop` relay is **abandoned** (rejected "admin permission" regardless
of ADMIN grants — airdrops now go fully on-chain from the creator's EOA, see G3).

### Layer D — Storage & media

#### D1. Arweave permanent storage via ArDrive Turbo (`arweave-storage`)
**What.** Permanent media/metadata storage returning `ar://<txid>` URIs. A
**signing-proxy split**: the client streams media bytes **directly** to Turbo
(browser→Turbo, server never sees them) while `/api/sign` RSA-PSS-signs only the
48-byte SHA-384 deep-hash with the server-only `ARWEAVE_JWK`. Metadata JSON (small)
goes through `/api/upload` server-side.

**Why.** NFT media must be permanently hosted, but the platform pays from a single
Arweave wallet that must never reach the browser, yet media is large and shouldn't
be proxied through serverless. The signing-proxy split resolves this. Almost
everything else is incident scar tissue: `e345018` added **cross-reload resume
persistence** because salted data-item ids never dedupe, so a creator retrying after
a failed mint re-uploaded (and re-billed) byte-identical files; `d7c090d` surfaced
the opaque Turbo 402 (credit exhaustion); `0ce38ee` turned propagation verification
into a soft-gate (Turbo guarantees durability on txid return); `1bf7b1b` added the
per-address sign-calls/upload-bytes quotas.

**Key mechanisms.** Duck-typed Arweave signer (only `publicKey`+`sign`); `paidBy`
shareCredits so users need no Turbo balance; deterministic 4xx short-circuit; a
`fetch` monkey-patch converting the SDK's `ReadableStream` body to a Blob (browsers
can't do request streaming); two-quota spend metering.

**Risks.** Spend backstop is thin — media bytes bypass the server so the only hard
ceiling is the sign-call count plus the wallet's funded float (`.env.example` warns
to keep it a bounded float and alert on balance); `ARWEAVE_JWK` is a hot funding
wallet; **the gateway pool is down to `arweave.net` alone** (see §6).

#### D2. Media pipeline (`media-pipeline`)
**What.** End-to-end media: in-browser + server GIF→MP4/faststart transcode,
poster/duration/thumbhash extraction, sharp image ops, the byte-range-owning
`/api/img` proxy, and multi-gateway fetch with fallback rotation. The most
heavily-worked area in the repo (`VIDEO_PLAYBACK_RCA.md`).

**Why.** Onchain art is hostile to browsers: iOS WebKit can't decode large animated
GIFs, videos need faststart + byte-range support, gateways are flaky, and
content-addressed URIs carry no mime/extension — all inside constrained Mini App
iframes/WebViews. The git story is a tight causal chain: `0f433b4` added `?w=`
sharp-downscale after a large cover 413'd the optimizer and stalled the Mini App's
HTTP/2 pool; `92499eb` (2026-07-04) **owned the range contract** after arweave.net
began 302-redirecting to sandbox hosts that drop `Accept-Ranges`/`Content-Length`
and answer ranged requests with `200`, which iOS AVFoundation refuses; `cfc8863`
added the **count-through + totals cache** because AVFoundation also rejects a
`bytes 0-1/*` unknown total; `12e30b8` classified the **React-Native WebView**
(mobile Mini App) as constrained after it was misread as desktop; `8060f8e` mirrored
totals in Redis; `ddda769` survived mid-read upstream deaths.

**Key mechanisms.** 206 synthesis over a rangeless upstream; real-total learning
(header harvest or bounded 8 MB/12 s count-through) cached in LRU + Redis; manual
domain-pinned redirect resolution so `Range` reaches the final sandbox host;
HTML-fallback rejection; byte-compatible dual transcode (wasm ≤100 MB / server
≤300 MB, `MAX_CONCURRENT=1`); surface classification (`isWebKitOnly` /
`isReactNativeWebView`) driving proxy-first delivery.

**Risks.** Single gateway (no fallback redundancy); no CDN yet (every constrained
byte streams through the box); UA-sniffing is brittle; `MAX_CONCURRENT=1` transcode
buffers whole GIFs (off-heap RSS spike bounded only by container memory).

### Layer E — Identity & social

#### E1. Farcaster Mini App integration (`farcaster`)
**What.** Turns Kismet into a first-class Farcaster/Base Mini App: SDK-gated host
detection, Quick-Auth JWT sessions, per-page cast embeds, a hub-signature-verified
webhook, and FID-keyed native push. The SDK is dynamically imported only inside a
host (never for regular web).

**Why.** Farcaster and the Base App are Kismet's primary distribution surface — the
integration makes shared moments render as launch cards, silently authenticates via
Farcaster identity, uses the host wallet to sign, and pushes creators when their
work is collected. History: `16d1757`/`6e369c3` fixed desktop splash hangs (a
Coinbase *extension* flag misclassifying a real FC iframe; unbounded host
round-trips); `24e8da9`/`485b3a9` fixed FC-API rate-limit responses being cached as
"no identity"; `12e30b8` added the RN-WebView leg.

**Key mechanisms.** Layered detection (cheap synchronous `isPotentialMiniAppEnv` →
authoritative async `sdk.isInMiniApp()`); splash-hang defense in depth (2.5 s /
3 s / 6 s watchdogs + idempotent dismiss); a **`window.fetch` interceptor**
attaching the Quick-Auth JWT as `Authorization: Bearer` on same-origin requests
(compensating for `SameSite=Lax` cookies dropped in cross-site iframes);
ed25519 + Hub app-key webhook verification; SSRF-guarded push host POSTs.

**Risks.** Hard dependency on `api.farcaster.xyz` (rate-limited, no fallback
indexer); the static `accountAssociation` (FID 527681) doesn't rotate and is
invalidated by a domain change; Quick-Auth JWTs (~1 h) have no server-side
revocation.

#### E2. Auth & session (`auth-session`)
**What.** Four deliberately-separated auth paths: **user SIWE** cookie sessions
(EIP-4361, 7-day sliding, `__Host-` opaque token), **Farcaster Quick-Auth** JWTs
(the Bearer fallback for cookie-hostile iframes), **intent-auth** (per-action EIP-712
signatures binding every economic field for mint/agent actions), and a separate
**admin/curator SIWE** session (`SameSite=Strict`, 4 h, gated on
`ADMIN_ADDRESS`/`CURATOR_ADDRESSES`).

**Why.** Authenticate wallet users across a browser and a cookie-hostile Mini App
without ever handing the client a forgeable credential, and authorize high-value
economic actions at finer grain than a login session. Docblocks record a hardening
migration from a prior scheme that replayed a raw SIWE signature in every admin
request body (4 h replay window) to single-use nonces + domain-bound signatures +
opaque httpOnly tokens. `83767c1` bounded the signal-less `api.farcaster.xyz` fetch
that runs on every authed Mini App request (a hung upstream drove OOM).

**Key mechanisms.** Verify-then-consume nonce ordering everywhere (signature checked
before atomic Redis `GETDEL`/`DEL`, so a bogus-signature flood can't burn a
legitimate nonce); **domain==Host** binding (anti-phishing); ERC-1271 support free
via viem `verifyHash`; strict separation of four Redis nonce/session namespaces and
two cookie names; intent-auth is what makes `body.account` trustworthy for the
downstream gate/blacklist/pause policy layer.

**Risks.** Redis is a hard dependency for every auth decision (degrades to
logged-out, safe, but an outage logs everyone out); a user session grants *only*
"this address is authenticated" — authorization is a separate check; `ADMIN_ADDRESS`
self-seeds a default (a fork forgetting to override inherits Kismet's admin identity).

#### E3. Profiles & identity (`profiles-identity`)
**What.** Resolves a raw address into one coherent display identity (Kismet
username/avatar → Farcaster @user+pfp → verified ENS → shortAddress), unifies a
user's wallets under one Farcaster FID, and drives the profile surface (owner authz,
content-derived theming, showcase pins).

**Why.** Users arrive with three identity origins (plain wallet, miniapp-first FC,
web-first FC) and often control several verified wallets; without a resolution layer
the same person fragments into disconnected shortAddresses with scattered earnings.
History: `459a006`/`fcb5254` extracted `ensCache`+`pickProfileIdentity` (one
CI-pinned precedence formula shared by single and batch routes); `24e8da9`/`56f8ff5`
made FC-API 429/5xx **not** cache as "no identity" (a definitive 404 vs a transient
sentinel), fixing 5-minute windows where a multi-wallet artist's sibling union
collapsed.

**Key mechanisms.** Three identity models in `resolveCanonicalProfile`
(React.cache-wrapped); `expandToFidSiblings` (identity) vs `expandToEarningsWallets`
(money — adds per-creator smart wallets); ENS **forward-verification** (reject
reverse records that don't forward-resolve back); canonical-URL 307 redirect;
owner-only content theming via sharp palette extraction.

**Risks.** Hard dependency on `api.farcaster.xyz`; ENS correctness depends on a
configured mainnet RPC; case-normalization is load-bearing (everything lowercased
before keying).

### Layer F — Data & platform infra

#### F1. Redis / KV store, caching & background tasks (`redis-kv-cache`)
**What.** A single shared `@upstash/redis` client — the app's **only** persistent
datastore — plus tiered caches (process-local `memoize` + browser `LRUCache`), a
Redis leader lock, a periodic sweep, and a passive health signal.

**Why.** Single-container deployment, no SQL DB, no failover peer, so Upstash is
simultaneously the datastore and a coordination primitive. The shape is dominated by
**cost** (`3a97179`: audited all 53 call sites — ~1M cmds/mo vs a 500K free cap →
auto-pipelining, 15-min memo TTLs, passive PING-skipping readiness, write-through
zsets) and **availability** (`80eae06`/`1bf7b1b`: retry cap 5→2 to stop an Upstash
blip becoming a site-wide brownout, dedicated non-pipelined probe client, bounds
against Upstash's 10 MB request cap).

**Key mechanisms.** `enableAutoPipelining` collapses same-tick commands into one
REST round-trip; `safeRead`/`strictRead` two-contract helpers; `memoize`
single-flight + generation-counter with per-write `.invalidate()`; `withLeaderLock`
(`SET NX EX` + Lua compare-and-delete); passive readiness (skip billed PING when
real traffic proved Redis healthy within 10 s).

**Risks.** Unbounded `SMEMBERS` sets (`getCreatedMintsSet` grows per-mint-ever and
hard-fails past 10 MB — deliberately excluded from boot warmup); no fail-fast on
missing env (boots with placeholder creds); process-local caches are per-pod (tuned
for a single instance).

#### F2. Rate limiting, quotas & abuse controls (`ratelimit-quota-abuse`)
**What.** The platform's abuse/DoS/spend firewall: IP fixed-window rate limits,
per-identity day/week spend quotas, SSRF guard (`safeUrl`), bounded request bodies,
address blacklist, CSPRNG nonces, and error hygiene (`upstreamError`).

**Why.** In front of operations that cost real money/compute — chiefly **Arweave/Turbo
credit drain** (the signing proxy signs any 48-byte hash and the client uploads
arbitrary-size media billed to the platform, which the server can't meter). So
ceilings are layered: sign-calls quota (200/day) + upload-bytes quota (500 MB/day) +
the operational wallet balance as the true backstop. `1bf7b1b` states the
load-bearing decision explicitly: blanket **fail-CLOSED quotas were deliberately
rejected** because during a Redis blip they'd deny every legitimate mint — the
chosen mitigation was shrinking the fail-open window (retries 5→2).

**Key mechanisms.** Atomic Lua for every counter (INCR+conditional-EXPIRE; two-bucket
day+week check-and-debit); uniform **fail-open**; two-tier keying (IP first, then
per-authenticated-identity — an attacker rotates IPs but not a wallet); SSRF guard is
https-only + no-IP-literal *without* DNS resolution.

**Risks.** Fail-open means a Redis outage silently disables *all* rate limits and
quotas (the planned global daily cap + balance alert is not yet implemented); airdrop
quota is **soft** (the on-chain mint is direct so skipping `/api/airdrop/notify`
bypasses it); `safeUrl` doesn't resolve DNS (DNS-rebinding residual).

#### F3. Telemetry, health, readiness & instrumentation (`telemetry-health`)
**What.** Everything at cold start plus process-health reporting on a
single-container deployment with no APM. Anchors: `instrumentation.ts`,
`lib/healthcheck.ts`, `app/api/health` + `app/api/readiness`, `lib/telemetry.ts`,
`lib/clientError.ts`, `lib/chainHealth.ts`.

**Why.** To catch config/upstream misconfigs at boot (not at a user's first mint),
keep probes honest so Coolify never restart-storms or evicts the only pod on a
transient blip, and give operators a diagnostic trail with no third-party APM. The
direct product of the June–July 2026 availability firefight: `80eae06` (fire-and-forget
boot + dedicated readiness client + consecutive-failure tolerance), `83767c1` (**the
OOM commit** — found the Next 15.x fetch-clone leak and added `[mem]` telemetry
because "the OOMs were diagnosed by inference — nothing recorded the heap between
crashes"), `5b1d618` (a notable **reversal** — removed a process-level crash net
after verifying Next 15's own log-and-continue handlers already keep the process
alive; the added `process.exit(1)` was crashing the container Next meant to keep
serving).

**Key mechanisms.** `register()` awaits nothing — six independently-guarded
fire-and-forget boot tasks; liveness always 200 (restart only fixes a wedged
process); readiness Redis-gated only after 3 consecutive failures via a dedicated
non-pipelined client; RPC non-gating; unauthenticated probes return `err.name` only;
`isChainStalled` two-read detection; `/api/client-error` as the only browser→server
log trail.

**Risks.** Everything is per-process (correct only for one instance); telemetry only
*observes* — the actual OOM mitigation is ops-side in Coolify; no APM at all.

#### F4. Config, feature flags & platform constants (`config-flags`)
**What.** The configuration spine — small, mostly dependency-free modules that
resolve platform addresses, the canonical `SITE_URL`, gate/pause flags, ERC-8021
builder attribution, and mini-app environment detection, with baked-in production
defaults so a missing env var degrades gracefully.

**Why.** A web3 app must thread a dozen addresses, RPC keys, API keys and flags
through both a server runtime and a browser bundle, per-deployment. Several files are
incident scar tissue extracted into tiny testable units: `gateFlags.isFlagSet`
(Upstash REST stores `'1'` as a string but JSON-parses GET back to `1`, so a naive
`raw==='1'` silently never persisted a toggle — shipped to prod once, 2026-05-24);
`siteUrl` trailing-slash strip (a double-slash can permanently invalidate Farcaster
notification tokens); `builderCode` hand-encodes ERC-8021 rather than importing
`ox/erc8021` (which pulled ~120 KB into every wallet-write bundle and tripped the
bundle-size gate).

**Key mechanisms.** Baked-in defaults with env override; ERC-8021 dual transports
(calldata suffix for EOA writes, EIP-5792 capability for `wallet_sendCalls`);
synchronous SDK-free surface detection (`isReactNativeWebView` keys on
`window.ReactNativeWebView`, injected before page scripts); cross-cap single-sourcing
(`MAX_AIRDROP_RECIPIENTS` shared by client and server).

**Risks.** Treasury-critical addresses live here; `OPERATOR_SMART_WALLET` has two
env vars that must match; `NEXT_PUBLIC_*` inlined at build time (change requires
redeploy); heuristic mini-app detection has bitten prod twice.

#### F5. Next.js framework, build & self-hosted deployment (`nextjs-build-deploy`)
**What.** The deployment substrate: Next 15 standalone built into a multi-stage
`node:22.22-alpine` Docker image, self-hosted on Oracle Ampere via Coolify/Traefik,
hardened against V8-heap OOM, with a postinstall patch for a Next fetch-clone leak
and a CI gate.

**Why.** A single self-hosted box with zero redundancy means every OOM,
signal-swallow, and stale-chunk 404 is a full outage that had to be engineered out in
code. Forged by an availability firefight: `80eae06` (de-block cold start, readiness
tolerance — but wrongly concluded a heap flag was unnecessary), `ca75ca0` (reversed
course: `--max-old-space-size=4096` after prod OOM'd at ~2030 MB with no cgroup
limit), `83767c1` (root-caused the *growth* to a Next 15 standalone fetch-clone leak
`#85914`, pinned `node:22.22-alpine`, patched the leak at postinstall), `1bf7b1b`
(CI assertion the patch applied + blocking critical audit + Dependabot).

**Key mechanisms.** `output: 'standalone'` + `node server.js` exec so SIGTERM
reaches Node; explicit heap caps as the only version-stable behavior (Node 22.x
default old-space drifted ~2 GB→~8 GB — hence the pin); build memory discipline
(`cpus:1`, `webpackMemoryOptimizations`, `ignoreBuildErrors`); security headers
deliberately omit X-Frame-Options/CSP to preserve the Warpcast webview embed and
rotating host pools; `next/image` disk cache LRU-capped at 5 GB.

**Risks.** Single instance / zero redundancy; the heap cap is a backstop not a fix
(in-code bounds must not regress); no CDN today (`/api/img` streams up to 2 GB
through the box); `ignoreBuildErrors` means a type error only surfaces in
`npm run check`/CI; the `vercel.json` cron is a pre-migration artifact that won't
fire on Coolify without an external scheduler.

### Layer G — Product subsystems

#### G1. Agent Collect / Scout autonomous engine (`agent-scout`)
**What.** The flagship feature: a per-user "Scout" grants a bounded Base **Spend
Permission** to Kismet's server spender, which then autonomously collects watched
artists' new drops within the on-chain allowance — plus a stateless **Agent Actions
API** (`prepare-collect/buy/list`) that returns inert unsigned EIP-5792/EIP-712
artifacts for an external Base MCP agent.

**Why.** Let collectors back a bounded budget once and have Kismet collect their
favorite artists' drops, with the safety that Spend Permissions cap **dollars**
on-chain (max loss = remaining period allowance, revocable) while Kismet's engine
enforces **what** off-chain. The concept predates the shallow boundary (PR #429,
2026-06-13); the entire budgeted subsystem lands squashed at `1160af1`; only 4 later
commits touch it, notably `1bf7b1b` (added `upstreamError()` to the public prepare
routes because raw viem errors leaked the server-only `BASE_RPC_URL` to anonymous
callers).

**Key mechanisms.** Custody-agnostic execution seam (a pure zero-import engine
decides *what*; an injected spender does the funded mint); dual budget cap (on-chain
dollars + off-chain policy); on-chain truth authoritative (period + spend from
`getPermissionStatus`; price/eligibility re-resolved before every spend); exact-cost
spend (`usdcAllowance:0n` forces a fresh per-collect approve so funds rest only
transiently); layered concurrency safety (per-(recipient,drop) `SET NX` lock,
shared-spender Redis mutex, per-owner run lock, on-chain `balanceOf` self-healing
dedup); **kill switch** (one Redis flag halts all autonomous spending without a
deploy); fair round-robin allocation across watchers for scarce drops; FID sibling
expansion.

**Risks.** Users grant to a **server-controlled** spender (compromise bounded but
not eliminated by the on-chain cap; the kill switch is the only server-side emergency
stop); non-atomic EOA fallback has a strand-funds window (capped to 1 edition/run);
paymaster loss hard-fails every collect; public prepare routes are unauthenticated
(IP-limited only); the live path is unverified in CI.

#### G2. Pass gate / token gating (`pass-gate`)
**What.** A **provenance-based** token gate: creator access requires a Pass NFT
acquired *entirely on-platform*. A Redis validity ledger is credited only through
proven Kismet flows (collect-mint, airdrop, Kismet secondary fill) and cross-checked
against live on-chain balances; the **Alchemy NFT-Activity webhook** revokes the
sender on any off-platform transfer and **permanently taints** the tokenId
(launder-prevention).

**Why.** Creator access should be a scarce, non-transferable-in-practice credential:
you earn it through Kismet, and you can't buy one on OpenSea to become a creator, nor
resell/launder a used Pass. A naive "holds the NFT" gate fails both goals. History:
lands at `1160af1`; `d30958e` deferred pass-collection minting to on-chain ADMIN;
`42d1c63` added CI guards for the Upstash string-vs-number flag bug; `3a97179` cut
the per-recipient/per-tx Redis command inflation.

**Key mechanisms.** Any-transfer-revokes invariant (unconditional `from` decrement
on every non-mint transfer); permanent taint (a tainted tokenId can never confer
validity again, even via a later Kismet sale, and is excluded from `liveTotal`);
per-(recipient,tokenId) platform-tx flag (so a co-bundled transfer can't ride the
flag to launder); dual-writer idempotent credit (synchronous direct-credit + async
webhook backstop converge on one `SET NX` key — the direct path must win the race or
the collector is stranded at `validBalance=0`); timing-safe HMAC webhook
verification; fail-closed at credit time / fail-open on read.

**Risks.** The webhook is single-point-critical for the *off-platform* half (no
active replay/backfill — it only warns); taint is permanent and irreversible except
by manual admin `removeTaint`; `creditValidityOnce` trusts its caller (correctness
depends on every path flagging only on-chain-proven pairs).

#### G3. Airdrops (`airdrops`)
**What.** Creators mint free copies directly to recipients via Zora `adminMint`
(single) / `multicall` (batch) **from their own EOA**, then record the airdrop
server-side (verified against the tx receipt) so it surfaces in the profile,
notifies recipients, credits Pass validity, and is throttled by a per-artist quota.

**Why.** Gift freshly-minted copies (especially the Pass NFT), with those gifts
appearing in the profile, notifying recipients, and granting the validity needed to
mint. The defining decision (`00a7e53`, 2026-06-21): the inprocess `/moment/airdrop`
relay rejected "admin permission" regardless of ADMIN grants, so airdrops moved to be
signed client-side by the creator's own already-authorized EOA (gas shifts to the
user). A cluster of race fixes (`99789dc`/`727fb0e`/`082deb3`/`a088224`) hardened the
Pass-validity credit and Redis command volume.

**Key mechanisms.** On-chain proof before any side effect (decode `TransferSingle`,
require `operator===sender, from===0x0`, rebuild the authoritative recipient set from
the receipt); mandatory `txHash` + NX idempotency acquired before quota debit;
synchronous per-recipient `creditValidityOnce`; single-source `MAX_AIRDROP_RECIPIENTS`
cap on client and server.

**Risks.** Quota is **soft** (direct mint bypasses `/api/airdrop/notify`); off-chain
record can be lost if all retries fail after the mint lands (recovery via the admin
`airdrop-record` endpoint); operator-wallet ADMIN coupling (a missing grant reverts
curated/admin-mint flows).

#### G4. Notifications (`notifications`)
**What.** Two transports over one event model: an address-keyed in-app bell/feed
(read/mute/type-mute state, cached unread counts, 10 event types) and a parallel
FID-keyed Farcaster native push.

**Why.** A social marketplace needs to tell users when money-bearing and social
events happen to them; native push was layered on so Mini App users get OS-level
pushes deep-linking back into Kismet — without the push path ever breaking the
primary write. History: `1160af1` (push atop the pre-existing bell); `1beefb8`
(made `agent_collect` a priority type so autonomous spends badge the bell — the only
signal money moved on the server path); `83767c1` (chunk `getMomentMetaBatch` MGET
at 512 keys to stay under the 10 MB cap).

**Key mechanisms.** Read state is **computed, never stored** (from a last-read
watermark or per-id read set); priority-and-unread cached badge count with
DEL-on-write invalidation; lazy 60-day TTL retention; two-axis mute with a
money-bearing bypass (`sale`/`airdrop`/`payout` reach the user regardless); FC push
is fire-and-forget behind 7 short-circuit gates ending in a `SET NX` idempotency key;
signed inbound webhook (ed25519 + Hub app-key).

**Risks.** `MAX_PER_USER=200` hard cap silently drops oldest; `loadAndAnnotate`
loads all entries on every page (in-memory pagination); push delivery is best-effort
and unobservable.

#### G5. Feeds: Discover / Featured / Search / Timeline / Stats / Curation (`feeds-discover`)
**What.** The content-surface layer: cross-collection Discover/Trending/Mints feeds,
admin curation (Featured + creator lists), multi-entity search, and per-artist
earnings stats rebuilt from the inprocess `/transfers` feed (USD-valued via the
Chainlink read).

**Why.** Kismet needs browsable surfaces over a catalog it doesn't index — inprocess
exposes only per-collection endpoints, so the app fans out and merges. The stats
subsystem exists because artists need a trustworthy earnings figure: v1 (`222070e`)
credited from the client-side collect counter (only Kismet-client collects, no
history); `4bfdc11` rewrote it to rebuild absolute totals from the complete
historical `/transfers` record; Chainlink exists solely to blend ETH+USDC into one
USD view (they can't be summed without a price oracle).

**Key mechanisms.** Bounded-concurrency fan-out (10) with a hard `MERGE_BUDGET` OOM
bound (the merge is the direct OOM vector once the never-pruned tracked set passes
~250 collections); absolute-swap stats rebuild (staging zsets → atomic RENAMEs, guarded
by single-flight + wipe/shrink/dedup circuit breakers); one shared creator-resolution
precedence so "what you see" and "what you're paid" agree; honest USD (unpriceable
ETH → `usd=0`); viewer-dependent cache policy (personal feeds `no-store`, shared
sorts `s-maxage=30`).

**Risks.** Full-scan stats has a ceiling (`MAX_PAGES=1000`); secondary-royalty
earnings only capture Kismet-listing resales (off-platform resales invisible); USD
silently disappears when the oracle is unavailable.

#### G6. Moments & collections domain model (`moments-collections`)
**What.** The core content objects — how a "moment" (a Zora 1155 token) and a
"collection" (a 1155 contract) are fetched from inprocess, corrected/enriched with
KV data, priced from chain, hidden/permissioned, and cached.

**Why.** Kismet needs one trustworthy "who made this, what is it, what does it cost,
who can see it" — but inprocess is lossy and mis-attributing for Kismet's own mint
flows (`momentAdmins[0]` is not reliably the minter; delegated mints credit the
platform SW) and subject to indexing lag. This is the correction/enrichment/caching
layer so every UI surface agrees. History: `9e505eb` (recover-landed-deploy),
`80eae06` (fan-out bounds), `3a97179` (15-min memo TTLs), `c9649bb`→`6ad4e9b` (Patron
Collection moving from a hardcoded "turro" credit to on-chain-split attribution).

**Key mechanisms.** Creator-resolution priority chain (KV minter EOA → inprocess
timeline creator → first non-operator `momentAdmin`); React.cache-wrapped fetch;
on-chain saleConfig fallback; three-tier read-time hidden cascade
(moment/collection/author) over memoized Redis Sets that **throw rather than
fail-open** (a blip can't reveal hidden content — except hidden-users, deliberately
fail-open); cover-mint synthesis + backfill (factory-deployed covers bypass the
indexer); `findLandedDeploy` deploy idempotency.

**Risks.** Hard dependency on inprocess; the single-instance "no cross-pod staleness"
assumption is load-bearing for hide/track correctness; on-chain price fallback +
ADMIN verification depend on Base RPC.

---

## 4. How it all works together — end-to-end flows

Seven flows stitch the components above. Each was traced through the real call path.

### 4.1 Mint flow (create a moment / deploy a collection)
Two on-chain models coexist. **Mint:** the browser signs only an off-chain EIP-712
*intent*; the server relays the userOp through inprocess, which executes it as the
creator's per-creator smart wallet (must hold Zora ADMIN at tokenId 0). **Deploy:**
the browser signs the Zora factory `createContract` directly, baking `setupActions`
that grant the inprocess SW + operator ADMIN so future relayed mints work.

Path: prepare media client-side (transcode/poster/thumbhash/duration) → establish
upload session → stream media browser→Turbo while `/api/sign` signs the 48-byte hash
server-side → soft-gate propagation → sign the EIP-712 intent (the *only* wallet
prompt on the mint path) → `POST /api/mint|/api/write` → `mint-proxy` (the platform
trust boundary: verify intent, blacklist/pause/gate/quota, `validateSplitsArray`,
smart-wallet ADMIN preflight, **overwrite `createReferral`**, strip private fields) →
forward to inprocess with `INPROCESS_API_KEY` → inprocess submits the userOp (Zora
`setupNewToken` + SplitMain deploy) → synchronous `creditValidityOnce` for Pass mints
→ `after()` KV writes (`markCreatedMint`, `setMomentMeta`, splits index,
notifications, `recordPlatformTx`, agent drop-coordination). **Feed appearance is
driven by the KV writes, not the mint tx** — so a just-minted moment appears before
the indexer catches up.

### 4.2 Collect flow (buy/collect a moment)
Three surfaces converge on one trust boundary. A **direct wallet collect**
(`useDirectCollect`) reads the *live* on-chain sale (never trusts the feed price),
signs a Zora `mint()` (ETH) or `ERC20Minter.mint()` (USDC), then best-effort POSTs
`/api/collect` with the txHash. `/api/collect` is **unsigned** — its only defense is
`verifyMintOnChain`, which fetches the receipt and requires a `TransferSingle` from
the collection contract with `from=0x0, to=account, id=tokenId` (fail-closed 403).
tokenId is `BigInt`-canonicalized (defeats `'01'` idempotency bypass); a `SET NX`
idempotency gate; then trending zsets, collected list, synchronous
`creditValidityOnce` (Pass), and a server-derived notification price. **Collect-all**
batches via Multicall3 (`aggregate3Value` for pure-ETH) or EIP-5792
`wallet_sendCalls`. The **agent variant** returns inert EIP-5792 calldata that
re-enters the same `/api/collect`. A **secondary buy** is a separate Seaport
`fulfillOrder` settled via `PATCH /api/listings/[id]` using `OrderFulfilled`-event
verification. _(Note: the collect path does **not** go through inprocess — that's the
mint/create relay.)_

### 4.3 Agent Scout autonomous collect
Eligibility gate (EIP-5792 capability / `eth_getCode`) → user signs **one** bounded
Spend Permission to the scout spender (the only user-signed money-moving step) → the
config PUT is owner-scoped by the SIWE session and **F3-validated** (permission's
`account`===owner AND `spender`===`NEXT_PUBLIC_SCOUT_SPENDER_ADDRESS`) → on app-open
/ "Run now", `runScoutServer` checks the **kill switch**, anchors budget to
`getPermissionStatus`, discovers watched artists' drops, plans against the pure
engine, and for each approved collect: re-resolves price on-chain, per-(recipient,drop)
`SET NX` lock + TOCTOU re-clamp, composes `[spend()][mint]` and submits through the
shared spender (atomic CDP userOp, gasless via paymaster; or sequential EOA fallback,
1 edition/run), then records to the proof-gated `/api/collect`. A separate
**drop coordinator** fires from the mint-proxy post-mint hook the instant a watched
artist mints, round-robin-allocating a scarce drop across all watchers. The on-chain
Spend Permission is the authoritative dollar cap; the engine only mirrors it.

### 4.4 Pass-gate validity lifecycle
On-platform acquisition (collect / airdrop / Kismet fill) → the API handler
**synchronously** `creditValidityOnce` (it must win the race against the Alchemy
webhook, which often arrives first and would skip the credit + burn its processed
key, stranding the holder) and schedules `recordPlatformTx` as the convergence
backstop. Off-platform transfer → the Alchemy webhook (HMAC-verified) runs
`processTransfer`: **unconditionally** decrements the sender, credits `to` only if
the (recipient,tokenId) pair was platform-flagged, and **permanently taints** the
tokenId if the transfer wasn't platform-flagged and wasn't Kismet-listed. Enforcement
(`hasValidPass`) reads `balanceOfBatch` excluding tainted ids and clamps the ledger
down; the `usePassGate` client read is a UX hint only.

### 4.5 Media upload → delivery → playback
Media bytes go **browser→Turbo→Arweave and never through the Kismet server** on
upload; only the 48-byte deep hash (→`/api/sign`) and metadata JSON (→`/api/upload`)
touch the server. On delivery, bytes come back via next/image's optimizer (still
images, AVIF/WebP, 31-day edge cache) or `/api/img` (proxy for GIFs/large images and
for video on WebKit/iframe/Mini-App), which races the gateway pool, follows
arweave.net's 302→sandbox redirects manually so `Range` reaches the final host,
synthesizes RFC-9110 `206`s with real learned totals (iOS AVFoundation refuses `200`
and `bytes 0-1/*`), and re-serves with 1-year immutable caching. Trust boundaries:
`/api/sign` (session cookie + 48-byte guard + quota, JWK stays server) and `/api/img`
(ar/ipfs-only SSRF guard + per-hop redirect domain-pinning).

### 4.6 Auth & session
Three keyspaces, deliberately separated: **user** (nonce keyed by address, 7-day
sliding `__Host-` Lax cookie, gates resource-spend via `getSessionAddress`), **admin**
(nonce keyed by value, 4 h `SameSite=Strict` cookie, authz on
`ADMIN_ADDRESS`/`CURATOR_ADDRESSES` re-checked per request), and **intent** (per-action
EIP-712 bound to the exact economic body + chainId 8453, verified in mint-proxy
independent of session). All three signature verifications route through viem against
Base RPC and support ERC-1271 smart wallets. The session cookie and Farcaster Bearer
JWT are unified behind one `getSessionAddress` so every endpoint accepts either.

### 4.7 Boot / deploy / runtime lifecycle
Coolify builds the multi-stage image (`node:22.22-alpine` pinned; deps compiles
`bufferutil` from source for ARM-musl; postinstall patches the Next fetch-clone leak
and copies ffmpeg-core; builder runs `next build` at heap 3072; runner installs
ffmpeg, runs non-root, heap 4096, execs `node server.js`). Next awaits
`register()`, which **returns immediately** and fires six independently-guarded
fire-and-forget boot tasks (platform-collection ADMIN healthcheck, `/smartwallet`
drift probe with `skipCache`, L1 cache warm, cover-meta backfill, background sweep
under a leader lock, `[mem]` telemetry). Liveness `/api/health` is always 200
(restart-only for a wedged process); readiness `/api/readiness` Redis-gates only
after 3 consecutive failures via a dedicated non-pipelined client and treats RPC as
non-gating. SIGTERM reaches Node directly for a graceful drain (no custom handler —
Next 15's built-in shutdown does it).

---

## 5. Cross-cutting concerns

- **Single-instance availability is the dominant design constraint.** One container,
  one host, no failover. Almost every infra choice leans toward *never* pulling or
  crashing the only pod over a transient dependency blip: liveness always-200,
  readiness consecutive-failure tolerance + non-gating RPC, fire-and-forget boot, no
  self-installed crash handler (Next's log-and-continue survives stray errors), and
  three independent OOM mitigations (pinned Node, explicit heap caps, the
  fetch-clone leak patch) plus `[mem]` telemetry.
- **Redis cost + the 10 MB request cap** shape the data layer: auto-pipelining,
  15-min memo TTLs, passive readiness, write-through zsets, MGET chunking, and
  bounded fan-outs all exist to stay under ~500K commands/month and avoid unbounded
  `SMEMBERS`.
- **Treasury-critical constants** (`CREATE_REFERRAL`/`KISMET_REFERRAL`,
  `PLATFORM_FEE_RECIPIENT`, `RESIDENCIES_ADDRESS`) route real revenue; a silent env
  swap redirects future income. The server overwrites client-supplied referral to
  prevent capture. These deserve a dedicated Gnosis Safe (per the code comments).
- **Security posture is fail-open on availability, fail-closed on money/laundering.**
  Rate limits and quotas fail open (a Redis blip mustn't deny mints); pass-gate taint
  and `isTokenTainted` fail closed (a downed Redis mustn't launder validity). SSRF is
  gated by `safeUrl` across five server-fetch sinks. `/api/sign`'s 48-byte guard is
  the only thing stopping the funding key from signing arbitrary data.
- **Spend controls are layered but the ultimate backstop is operational.** Arweave
  credit drain is bounded by sign-call quotas but ultimately by keeping the wallet a
  bounded float and alerting on balance; autonomous agent spend is bounded on-chain by
  the Spend Permission and operationally by the kill switch.

---

## 6. Notable findings surfaced during this review

These were discovered while validating against code and are worth an owner's
attention (verified at the cited lines). None is a request to change anything here —
they are flagged for follow-up.

1. **Arweave gateway pool collapsed to a single host.** `lib/arweave/gateways.ts:19-21`
   — `ARWEAVE_GATEWAYS = ['https://arweave.net']`; `g8way.io`, `ar-io.dev`,
   `permagate.io`, and `arweave.dev` were all pruned May–June 2026 as they died.
   There is now **no gateway redundancy** for pre-mint verification or render
   fallback — a single arweave.net edge stall has no alternate. The file comment
   itself asks to re-add a curl-verified fallback. (Compounds the single-instance
   availability risk.)
2. **A `dns-prefetch` still targets a dead host.** `app/layout.tsx:74` emits
   `<link rel="dns-prefetch" href="https://permagate.io" />` — a gateway
   `lib/arweave/gateways.ts` explicitly pruned as non-functional (TLS outage). The
   two files have drifted.
3. **Four env vars are read in code but absent from `.env.example`** (verified: grep
   count 0 in `.env.example`): `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN` (the **core datastore** — an operator following the
   example alone ships a non-functional app), `NEXT_PUBLIC_RESIDENCIES_ADDRESS`
   (`lib/config.ts:19`, a revenue recipient), and `CURATOR_ADDRESSES`
   (`lib/config.ts:81`, a privilege-granting allowlist).
4. **`lib/safeUrl.ts` is an unowned cross-cutting security control.** The
   `isSafePublicHttpsUrl()` SSRF guard gates five server-fetch sinks (OG/share
   render, ENS-avatar fetch, transcode-gif, Farcaster notification POSTs,
   colorExtract) but belongs to no single subsystem. It deliberately does not resolve
   DNS, so a public hostname resolving to an internal/metadata IP (DNS-rebinding) is
   not blocked — https-only mitigates but doesn't eliminate the residual.
5. **Fail-open quotas have no implemented hard backstop yet.** During a Redis outage
   all rate limits and spend quotas silently pass; the planned "global daily cap +
   balance alert" fail-closed backstop is noted as *planned*, not implemented
   (`1bf7b1b`). The operational Arweave wallet balance is the only remaining ceiling.
6. **The `vercel.json` cron won't fire on Coolify** without an external scheduler
   hitting `/api/cron/sync-stats` — if unconfigured, artist earnings stats silently
   stop refreshing.
7. **Minor label fix (already corrected in this doc):** the marketplace is **Seaport
   1.5** (`lib/seaport.ts:93` EIP-712 domain `version: '1.5'`), not 1.6 as one
   inventory pass guessed.

---

## Appendix — component index

| # | Component | Category | Anchor |
|---|---|---|---|
| A1 | EVM wallet & RPC layer | protocol | `lib/wagmi.ts`, `lib/rpc.ts` |
| A2 | CDP, Base Account & smart-wallet resolution | external-service | `lib/agent/scout/spender.ts`, `lib/resolveSmartWallet.ts` |
| B1 | Zora minting protocol & mint flow | protocol | `lib/zoraMint.ts`, `lib/mint-proxy.ts` |
| B2 | Seaport secondary marketplace | protocol | `lib/seaport.ts`, `lib/listings.ts` |
| B3 | Splits, royalties & platform fees | internal | `lib/splits.ts`, `lib/platformFee.ts`, `lib/stats.ts` |
| C1 | inprocess.world API integration | external-service | `lib/inprocess.ts`, `lib/mint-proxy.ts` |
| D1 | Arweave storage via ArDrive Turbo | external-service | `lib/arweave/*`, `app/api/sign` |
| D2 | Media pipeline | internal | `lib/media/*`, `app/api/img` |
| E1 | Farcaster Mini App integration | external-service | `providers/FarcasterProvider.tsx`, `lib/farcaster*` |
| E2 | Auth & session | internal | `lib/session.ts`, `lib/intentAuth.ts`, `lib/curator.ts` |
| E3 | Profiles & identity | internal | `lib/addressUnion.ts`, `lib/ensCache.ts` |
| F1 | Redis / KV / caching | infrastructure | `lib/redis.ts`, `lib/kv.ts` |
| F2 | Rate limiting, quotas & abuse | internal | `lib/ratelimit.ts`, `lib/userQuota.ts`, `lib/safeUrl.ts` |
| F3 | Telemetry, health & instrumentation | infrastructure | `instrumentation.ts`, `lib/healthcheck.ts` |
| F4 | Config, feature flags & constants | internal | `lib/config.ts`, `lib/builderCode.ts` |
| F5 | Next.js framework, build & deploy | build-deploy | `Dockerfile`, `next.config.mjs` |
| G1 | Agent Collect / Scout | internal | `lib/agent/scout/*` |
| G2 | Pass gate / token gating | internal | `lib/pass-validity.ts`, `app/api/webhooks/pass-transfer` |
| G3 | Airdrops | internal | `lib/airdrops.ts`, `app/api/airdrop/notify` |
| G4 | Notifications | internal | `lib/notifications.ts`, `lib/farcasterNotifications.ts` |
| G5 | Feeds / Discover / Stats / Curation | internal | `app/api/timeline`, `lib/stats.ts` |
| G6 | Moments & collections domain | internal | `lib/momentDetail.ts`, `lib/collections.ts` |

_Generated from a full multi-agent read of the codebase + git history, validated
against `file:line`. Where a subsystem predates the shallow-clone boundary
(~2026-06-12), its pre-boundary origin is noted as unavailable and the design
rationale is taken from in-code docblocks and later commit messages._
