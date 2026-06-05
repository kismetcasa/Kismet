# Ethereum Mainnet Expansion — Full Scope

> Status: **Phases 1–3 landed.** P1 = chain registry + parameterized core libs.
> P2 = read model fully multichain. P3 = direct on-chain flows multichain
> (collect / collect-all / list / buy / cancel / airdrop / grant), all user-paid.
> All behind `NEXT_PUBLIC_ENABLE_MAINNET` (default off → Base-only, byte-identical).
> Remaining: distribute on mainnet (deferred) + Phase 4 (sponsored mint/deploy +
> Pass gate). Author pass: 2026-06-04.
>
> **Confirmed decisions** (see §6): mainnet minting is **user-paid / direct
> on-chain** (no relay dependency); the Creator Pass gate is **Base-only**; Base
> stays the default chain and mainnet ships behind `NEXT_PUBLIC_ENABLE_MAINNET`.
> Goal: let users **deploy, mint, collect, list, and buy** on **Ethereum Mainnet
> (chainId 1)** priced in **ETH or USDC**, now that In Process has deployed its
> 1155 protocol to mainnet — without regressing the existing Base (8453) product.

This document is the single source of truth for the migration. It (1) reviews
what In Process shipped, (2) inventories **every** place the codebase touches
Base, and (3) lays out a phased, end-to-end build with the decisions and risks
that gate it.

---

## 0. TL;DR for the impatient

- The platform is **single-chain today**: Base (8453) is hardcoded in ~60 places.
  `mainnet` is already a wagmi chain but is used **only for ENS resolution**.
- In Process's mainnet protocol uses **different addresses** for the two
  contracts we actually call (`FIXED_PRICE_SALE_STRATEGY`, `ERC20_MINTER`) plus a
  different factory. USDC is a different token on mainnet. So our hardcoded
  "Zora/Base" constants must become **chain-keyed lookups**.
- There are **four on-chain flows**, each pinned to Base:
  1. **Deploy collection** — user-paid, direct `createContract` (client wallet).
  2. **Mint a moment** — **platform-sponsored / gasless** via the In Process relay
     (`/api/mint`, `/api/write` → `api.inprocess.world`).
  3. **Collect / buy / list / airdrop / distribute** — user-paid, direct on-chain.
  4. **Read model** — In Process REST API, every call hardcodes `chain_id=8453`.
- **Two things gate the headline "mint on mainnet" feature and must be resolved
  first** (Phase 0):
  - **(A) Does the In Process *create* relay accept a `chainId`?** Their docs do
    not show one and the API returns `chainId: 8453`. If it does not support
    mainnet, the *sponsored* mint path cannot target mainnet.
  - **(B) Gas economics.** Sponsoring gas on mainnet (the relay pays via our API
    key) can cost **$5–$50+/mint** vs. cents on Base. This likely forces mainnet
    minting to be **user-paid (direct on-chain)** rather than sponsored — which,
    conveniently, also sidesteps (A).
- Recommended architecture: a **chain registry** (`lib/chains.ts`) that every
  flow reads from; Base stays the default; mainnet ships behind a feature flag.

---

## 1. What In Process shipped

Source of truth: `in-process-protocol/packages/1155-deployments/addresses/<chainId>.json`.

### 1.1 Address diff — Base (8453) vs Ethereum (1)

| Key | Base `8453.json` | Ethereum `1.json` | Same? | We call it? |
|---|---|---|---|---|
| `CONTRACT_1155_IMPL` | `0xAc9DAA192CEdBD1C84466De8c5Ee1114da5df976` | `0x9519EC9bB3d0c93dDDC68a6f0392bAc13B202915` | ❌ | indirect |
| `CONTRACT_1155_IMPL_VERSION` | `2.13.2` | `2.13.2` | ✅ | — |
| `ERC20_MINTER` | `0xE27d9Dc88dAB82ACa3ebC49895c663C6a0CfA014` | `0x0676b307D53EA7ED80b20643E1Ac57A78Ce12f87` | ❌ | **YES** |
| `FACTORY_IMPL` | `0x2363114D9E889CC0e6D5F23D751D9d52D68845B2` | `0x1037526fC2736Baf2C379B530450583eF241e35c` | ❌ | no |
| `FACTORY_PROXY` | `0x4c6b9b23be9dC281C8D49FEDAed89C57a00d3b1f` | `0x2bf5EBEEb028D5F9E02F0F432Ebb1a192F5528F1` | ❌ | see §1.3 |
| `FIXED_PRICE_SALE_STRATEGY` | `0x2994762aA0E4C750c51f333C10d81961faEBE785` | `0xe0d3febE1c17DDA1086e89B638Ab54955FE2eF8a` | ❌ | **YES** |
| `MERKLE_MINT_SALE_STRATEGY` | `0x20bcc5B85e8fc5B2274018593A5cf6a3CeA7BA0d` | `0x20bcc5B85e8fc5B2274018593A5cf6a3CeA7BA0d` | ✅ | no |
| `PREMINTER_IMPL` | `0x50A2E2694646a025CD7f4f51B8bb0D448C89c901` | `0x12647948f69aD43FB6bfe65BcA62DDCe48dE7838` | ❌ | no |
| `PREMINTER_PROXY` | `0x7777773606e7e46C8Ba8B98C08f5cD218e31d340` | `0x7777773606e7e46C8Ba8B98C08f5cD218e31d340` | ✅ | no |
| `REDEEM_MINTER_FACTORY` | `0x82DAc8b967624A049d16Ef3212bfAB97f668b289` | `0x82DAc8b967624A049d16Ef3212bfAB97f668b289` | ✅ | no |
| `UPGRADE_GATE` | `0xbC50029836A59A4E5e1Bb8988272F46ebA0F9900` | `0xbC50029836A59A4E5e1Bb8988272F46ebA0F9900` | ✅ | no |

**Takeaways**

- The two strategy contracts we call on **every collect/list/sale read**
  (`FIXED_PRICE_SALE_STRATEGY`, `ERC20_MINTER`) are **different on mainnet**.
  Our `lib/zoraMint.ts` hardcodes the Base ones and labels them "Zora … Base
  mainnet (chainId 8453)". These must become per-chain.
- `MERKLE_MINT_SALE_STRATEGY`, `PREMINTER_PROXY`, `REDEEM_MINTER_FACTORY`,
  `UPGRADE_GATE` are identical across chains (deterministic deploys). We don't
  use them today, but if we ever do, they can be treated as constants.

### 1.2 Currencies & shared infra

| Thing | Base (8453) | Ethereum (1) | Notes |
|---|---|---|---|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | **Different.** Mainnet = canonical Circle USDC (verified on Etherscan + Circle docs). Both 6-decimals. |
| ETH | native | native | same handling |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | `0xcA11bde05977b3631167028862bE2a173976CA11` | same (deterministic) |
| Seaport 1.5 | `0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC` | `0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC` | same address (deterministic); **EIP-712 domain `chainId` differs** |

### 1.3 ⚠️ The factory address discrepancy (must verify before mainnet deploy)

Our deploy path (`lib/collections.ts`) calls
`FACTORY_ADDRESS = 0x540C18B7f99b3b599c6FeB99964498931c211858`.

- This **matches In Process's docs** (`protocol-deployments.mdx` lists the Base
  factory as `0x540C18B7…`) — *not* the `FACTORY_PROXY` in `8453.json`
  (`0x4c6b…`). So In Process publishes **two different "factory" addresses** for
  Base, and our deploy uses the **docs** one.
- The docs page currently lists **only Base + Base Sepolia** — there is **no
  documented mainnet `createContract` factory** yet.
- Therefore we **cannot assume** the mainnet deploy factory is `1.json`'s
  `FACTORY_PROXY` (`0x2bf5…`). **Action:** get the mainnet equivalent of
  `0x540C18B7…` from In Process (updated docs, their mainnet frontend's
  `createContract` target, or an on-chain `SetupNewContract` emitter), and only
  then wire the mainnet deploy path. Using the wrong factory = tx confirms but
  emits no `SetupNewContract` (exactly the failure the existing code comments
  describe for the wrong-chain testnet address).

---

## 2. Current architecture (how Base is wired today)

### 2.1 The four flows

1. **Deploy collection** — `components/CreateCollectionForm.tsx`. User's wallet
   calls `createContract` on `FACTORY_ADDRESS` (`base.id`), grants ADMIN to the
   artist's + operator In Process smart wallets via `setupActions`, optionally
   mints a cover token. **User pays gas.** Receipt watched on `base.id`.

2. **Mint a moment** — `components/MintForm.tsx` → `/api/mint` or `/api/write`
   → `lib/mint-proxy.ts` → `api.inprocess.world/api/moment/create`. The user
   signs an **EIP-712 intent** (off-chain); the **In Process relay submits the
   userOp on-chain and pays gas** via our `INPROCESS_API_KEY` (operator smart
   wallet). **Platform-sponsored / gasless.** `forwardBody` carries **no
   chainId** → upstream defaults to Base.

3. **Collect / buy / list / airdrop / distribute** — user-paid, direct on-chain:
   - `hooks/useDirectCollect.ts`, `hooks/useCollectAll.ts` (collect / collect-all)
   - `components/BuyButton.tsx`, `components/ListButton.tsx`, `components/MarketCard.tsx`
     (Seaport listings)
   - `hooks/useAirdrop.ts`, `hooks/useGrantPermission.ts` (admin ops)
   - `app/api/distribute/route.ts` + `hooks/useMomentSplits.ts` (splits payout —
     this one is **relayed** via In Process with explicit `chainId: 8453`)

4. **Read model** — In Process REST (`lib/inprocess.ts` `INPROCESS_API`). Every
   timeline / collection / moment fetch hardcodes `chain_id=8453`.

### 2.2 Server-side on-chain reads — the `serverBaseClient()` singleton

`lib/rpc.ts` exposes a **single cached Base client**. Every server-side
verification reads Base through it:

- `lib/intentAuth.ts` — verifies the mint intent (EIP-712 + EIP-1271).
- `lib/smartWalletPreflight.ts` — reads `permissions()` for AUTHORIZE_REQUIRED.
- `lib/healthcheck.ts` — operator ADMIN on `PLATFORM_COLLECTION`.
- `lib/siweLogin.ts`, `lib/pass-validity.ts` (gate), `app/api/collect`,
  `app/api/distribute`, `app/api/listings` (royalty), `app/api/listings/[id]`
  (fill receipt), `app/api/airdrop/notify` (receipt),
  `app/api/collection/authorized-creators`, `app/api/collection/hide`,
  `app/api/moment/update-uri`, `app/api/readiness`,
  `app/api/featured/collections-hydrated`.

**All of these must become chain-parameterized** for any flow that can run on
mainnet.

### 2.3 Identity binding pinned to Base

- `lib/intent.ts` `KISMET_INTENT_DOMAIN.chainId = 8453` — the mint-intent EIP-712
  domain. (Off-chain binding; needs a per-chain value **and/or** an explicit
  `chainId` field so a Base intent can't be replayed as a mainnet mint.)
- `lib/seaport.ts` `SEAPORT_DOMAIN.chainId = 8453` — listing order domain.
- `contexts/AdminContext.tsx` SIWE admin session `chainId: base.id`.
- `hooks/useUploadSession.ts` SIWE upload session `chainId: base.id`.

---

## 3. Complete Base-touchpoint inventory

Grouped by the change each needs. File:line are anchors, not exhaustive.

### A. Chain config / clients (make chain-aware)
- `lib/wagmi.ts:133-167` — `chains: [base, mainnet]`; `client()` gives **Base**
  multicall batching but **mainnet only a plain transport** (it's ENS-only
  today). Mainnet needs the same `batch: { multicall: true }` once we read
  protocol state there.
- `lib/rpc.ts` — `serverBaseClient()` hardcodes `base`. → `serverClient(chainId)`.
- `lib/useEnsureBase.ts` — switches to `base.id`. → `useEnsureChain()`.
- `providers/WagmiProvider.tsx:22` — `initialChain={base}` (keep as default).

### B. Protocol addresses (chain-keyed)
- `lib/zoraMint.ts:29-33` — `ZORA_FIXED_PRICE_STRATEGY`, `ZORA_ERC20_MINTER`,
  `USDC_BASE` (all Base). `MULTICALL3_ADDRESS` (:137) and `KISMET_REFERRAL` (:43)
  stay constant. `buildEthMintCall` / `buildUsdcMintCall` (:236, :272) hardcode
  the Base strategy + `USDC_BASE` → take a `chainId`.
- `lib/collections.ts:12` — `FACTORY_ADDRESS` (Base, the docs `0x540C…`); :18 re-
  exports the Base FPSS for cover-token setup. → chain-keyed (see §1.3 caveat).
- `lib/saleConfig.ts` — `STRATEGY_BY_CURRENCY` (:96) built from Base constants;
  `fetchEligibleTokens` / `readSalePricePerToken` → take a `chainId`.
- `lib/seaport.ts:11,91-96,337` — `SEAPORT_ADDRESS` (same), `SEAPORT_DOMAIN.chainId`
  (per-chain), `buildSellOrder` USDC (per-chain).

### C. Hardcoded `chain_id=8453` in In Process REST calls (read model)
`lib/inprocess.ts:288`, `lib/kv.ts:220`, `lib/momentDetail.ts:18,67`,
`lib/coverMomentSynthesis.ts:61,83,100`, `app/api/collections/route.ts:37,104,166`,
`app/api/timeline/route.ts:17`, `app/api/moment/route.ts:13`,
`app/api/moment/comments/route.ts:18`, `app/api/moment/hide/route.ts:59`,
`app/api/collection/route.ts:17`, `app/api/featured/collections-hydrated/route.ts:133`,
`app/collection/[address]/page.tsx:45,62,95`,
`app/collection/[address]/opengraph-image.tsx:31`,
`app/api/distribute/route.ts:129,202`, `app/api/moment/update-uri/route.ts:141`,
`components/MomentCard.tsx:235,250`, `components/MomentDetailView.tsx:413,456,839`,
`hooks/useMomentSplits.ts:151`.
→ Use the **moment's/collection's own `chain_id`** (already present in the
In Process read model — `Moment.chain_id` exists in `lib/inprocess.ts:77`), and
**fan out across chains** for the aggregate feeds.

### D. Client on-chain flows pinned to `base.id`
`hooks/useDirectCollect.ts` (:74,151,177,196,229), `hooks/useCollectAll.ts`
(:144,146,336,367,406,557), `hooks/useAirdrop.ts` (:64,85),
`hooks/useGrantPermission.ts` (:123,133,156,176), `hooks/useMomentSplits.ts`
(:109), `hooks/useAuthorizedCreators.ts` (:32), `hooks/useUploadSession.ts` (:82),
`components/CreateCollectionForm.tsx` (:83,135,602; basescan :208,647),
`components/MintForm.tsx` (USDC :590; basescan :1054),
`components/BuyButton.tsx` (:37…), `components/ListButton.tsx` (:54,111),
`components/MarketCard.tsx` (:55,106), `components/MomentDetailView.tsx`
(:230,576,839,1392), `components/CollectionView.tsx` (:242),
`contexts/AdminContext.tsx` (:215).

### E. Server on-chain reads via `serverBaseClient()`
See §2.2 list. All → `serverClient(chainId)`.

### F. Sponsored relay
- `lib/mint-proxy.ts` — forwards to In Process with **no** chainId (:192-195 build
  `forwardBody`; :241 the fetch); preflight `checkSmartWalletAdmin` reads Base
  (:219). → thread `chainId` to upstream (pending §0(A)) and preflight on the
  target chain.

### G. Identity binding
- `lib/intent.ts:57-61` (`KISMET_INTENT_DOMAIN`), `lib/intentAuth.ts:82`
  (verify on Base). → per-chain domain + `chainId` field; verify on target chain.

### H. Gate / Pass (Base-only by construction)
- `lib/pass-validity.ts`, `lib/pass-blacklist.ts`, `app/api/webhooks/pass-transfer`
  (Alchemy **NFT Activity on Base Mainnet** per `.env.example:206`),
  `app/api/pass-validity`, `lib/gate.ts`. → decision in §6 (recommend Base-only
  Pass at launch).

### I. Explorer links (hardcoded basescan.org)
`components/CreateCollectionForm.tsx:208,647`, `components/MintForm.tsx:1054`,
`components/MomentDetailView.tsx:576,1392`, `hooks/useAirdrop.ts:48` (comment).
→ `explorerTxUrl(chainId, hash)` / `explorerTokenUrl(...)` from the registry
(`etherscan.io` for mainnet).

### J. Config / env
- `lib/config.ts:3-5` — `PLATFORM_COLLECTION` single Base address (curated feed).
- `.env.example` — Base RPC + mainnet RPC (the latter labelled **ENS-only**).
  Mainnet RPC becomes a **first-class protocol RPC**; likely needs a higher-quota
  key than today's ENS usage assumes. Add `NEXT_PUBLIC_ENABLE_MAINNET` flag.

---

## 4. Target architecture — the chain registry

Introduce `lib/chains.ts` as the **one** place chain facts live. Everything in
§3 reads from it; nothing else hardcodes `8453`, `base`, an address, or an
explorer host.

```ts
// lib/chains.ts (shape sketch)
import { base, mainnet } from 'viem/chains'
import type { Address, Chain } from 'viem'

export type SupportedChainId = 8453 | 1
export const DEFAULT_CHAIN_ID: SupportedChainId = 8453

export interface ChainConfig {
  chainId: SupportedChainId
  chain: Chain                 // viem base | mainnet
  label: string                // 'Base' | 'Ethereum'
  // In Process / Zora protocol (per chain — see §1.1)
  fixedPriceStrategy: Address
  erc20Minter: Address
  factory: Address             // createContract entrypoint (docs addr; §1.3)
  // Currencies (per chain — see §1.2)
  usdc: Address
  // Marketplace
  seaport: Address             // same on both, kept here for one source of truth
  seaportDomainChainId: number // = chainId
  // Shared/deterministic
  multicall3: Address
  // Read model
  inprocessChainId: string     // String(chainId) for REST calls
  // Explorer
  txUrl: (hash: string) => string
  tokenUrl: (addr: string, tokenId: string) => string
  // RPC
  publicRpcUrl?: string        // NEXT_PUBLIC_*_RPC_URL (client + SSR)
  serverRpcUrl?: string        // *_RPC_URL (server-only, falls back to public)
  // Capability flags
  sponsoredMint: boolean       // Base: true; Ethereum: false (see §0/§6)
  gated: boolean               // Pass gate applies? Base: true; Ethereum: false
}

export const CHAINS: Record<SupportedChainId, ChainConfig> = { /* … */ }
export function getChain(id: number): ChainConfig // throws on unsupported
export function enabledChainIds(): SupportedChainId[] // honors NEXT_PUBLIC_ENABLE_MAINNET
```

Then mechanical refactors:
- `lib/zoraMint.ts`: constants → `fixedPriceStrategy(id)`, `erc20Minter(id)`,
  `usdc(id)`; `buildEthMintCall`/`buildUsdcMintCall` accept `chainId`.
  `KISMET_REFERRAL`, `MULTICALL3_ADDRESS`, `OPEN_EDITION_MINT_SIZE` stay constant.
- `lib/rpc.ts`: `serverClient(id)` with a `Map<chainId, client>` cache; keep
  `serverBaseClient()` as `serverClient(8453)` alias during migration.
- `lib/useEnsureBase.ts`: `useEnsureChain()` returning `(id) => switch if needed`.
- `lib/seaport.ts` / `lib/intent.ts`: domains become functions of `chainId`.

> **Backwards-compat rule for Phase 1:** every refactor defaults to `8453`, so
> Base behavior is byte-for-byte identical until a caller passes a different id.

---

## 5. End-to-end scope, phased

### Phase 0 — De-risk (BLOCKING; no app code)
- [ ] **Confirm the In Process *create* relay accepts `chainId`** for mainnet
      (`/moment/create`, `/moment/create/writing`). Docs don't show it. If
      unsupported → sponsored mainnet mint is impossible; pivot to user-paid
      (Phase 4, Option B).
- [ ] **Confirm the mainnet `createContract` factory** (the analog of
      `0x540C18B7…`; see §1.3). Do **not** assume `1.json` `FACTORY_PROXY`.
- [ ] **Confirm smart-wallet behavior on mainnet:** per-artist + operator In
      Process smart accounts are deterministic across EVM chains (same address),
      but ADMIN is per-collection/per-chain. Verify `/api/inprocess/smart-wallet`
      returns the right address for chain 1 and that ERC-1271 sigs verify there
      (the contract may be **counterfactual/undeployed** on mainnet until first
      use → needs ERC-6492 or an EOA fallback for intent verification).
- [ ] **Confirm the read APIs** (`/timeline`, `/collection`, `/collections`,
      `/moment`) return chain-1 data with `chain_id=1`.
- [ ] **Decide gas economics** (see §0, §6): sponsor mainnet gas or go user-paid.

### Phase 1 — Foundation (Base default, zero behavior change) ✅ DONE
- [x] Add `lib/chains.ts` (§4) — the registry: per-chain `ChainConfig` data
      (addresses, USDC, Seaport, explorer host, `label`) + capability flags
      (`sponsoredMint`, `gated`, `factoryVerified`) + `getChain` /
      `isSupportedChainId` / `publicRpcUrl` / `serverRpcUrl`. Both mainnet
      addresses verified against `1.json` and EIP-55 checksum-validated.
- [x] Refactor `zoraMint`, `rpc`, `useEnsureBase`, `seaport`, `saleConfig`,
      `collections`, `wagmi` to be chain-parameterized, defaulting to `8453`
      (Base behavior byte-identical). Back-compat aliases kept: `USDC_BASE`,
      `ZORA_FIXED_PRICE_STRATEGY`, `ZORA_ERC20_MINTER`, `SEAPORT_DOMAIN`,
      `serverBaseClient`, `useEnsureBase`, `FACTORY_ADDRESS`.
- [x] `serverClient(chainId)` factory (per-chain cache); `serverBaseClient()`
      kept as the Base alias.
- [x] `lib/wagmi.ts` drives RPC from the registry and gives mainnet
      `batch: { multicall: true }`.
- [x] `npm run check` green (typecheck + lint + resource-hints + bundle) and a
      full `npm run build`; **no UI exposes mainnet yet** (no caller passes a
      non-Base chain).

**No-bloat discipline:** Phase 1 ships only what current code calls plus the
registry spec data. Run-time logic for *later* phases was intentionally NOT
added here — `enabledChains` / `isMainnetEnabled` + the `NEXT_PUBLIC_ENABLE_MAINNET`
flag, the explorer URL builders, `getChainOrDefault`, and `intentDomain` all move
to the phase that first consumes them (Phase 2 / Phase 4). The registry holds
per-chain *facts*; consuming *logic* lives with its consumer.

Chain-aware seams now live for Phases 2–4 (each defaults to Base): `getChain(id)`,
`fixedPriceStrategy(id)`, `erc20Minter(id)`, `usdcAddress(id)`,
`buildEthMintCall({…, chainId})`, `buildUsdcMintCall({…, chainId})`,
`fetchEligibleTokens(…, chainId)`, `readSalePricePerToken(…, chainId)`,
`serverClient(id)`, `useEnsureChain()`, `seaportDomain(id)`.

### Phase 2 — Read model multichain (show mainnet content) ✅ DONE
- [x] Re-introduced the enablement + display helpers (with consumers):
      `isMainnetEnabled()` / `enabledChainIds()` / `isChainEnabled()` reading
      `NEXT_PUBLIC_ENABLE_MAINNET` (flag re-added to
      `.env.example`); `getChainOrDefault()`; `explorerTxUrl` / `explorerTokenUrl`.
- [x] **Data model:** `CollectionMeta.chainId` (legacy-default Base) +
      `getCollectionChainId()` / `getCollectionChainIdMap()` resolvers;
      `/api/collections` POST validates + stores `chainId` and verifies admin on
      the collection's own chain (`serverClient(chainId)`); `registerCollection`
      carries `chainId`.
- [x] Replaced every read-path `chain_id=8453` (§3.C) with the resolved chain:
      `lib/inprocess.fetchCollectionMoments`, `lib/momentDetail`,
      `lib/coverMomentSynthesis`, `lib/kv` (search backfill), `/api/moment`,
      `/api/moment/comments`, `/api/moment/hide`, `/api/collection`,
      `/api/collections` (single + feed + artist), `/api/timeline`,
      `/api/featured/collections-hydrated`, the collection + moment SSR pages
      (incl. the `@modal` intercept) and their OG images.
- [x] **Fan-out:** feeds / search / collections / featured resolve each
      collection's chain (one MGET) and **gate by `isChainEnabled`** so mainnet
      stays hidden while the flag is off. Each collection is queried on its own
      chain (one call — not doubled, since collections are single-chain). The
      artist `/collections` path fans out across `enabledChainIds()` and merges.
      The `/api/timeline` fan-out **stamps the queried chain onto every row** so
      client cards read the right chain even if inprocess omits `chain_id`.
- [x] `MomentCard` / `MomentDetailView` / `CollectionView` / `FeaturedMoment`:
      display on-chain reads (`balanceOf` / `getTokenInfo`) pinned to the moment's
      chain via `usePublicClient({ chainId })`; price/comments fetches pass the
      chain; explorer links via the registry. `/api/moment` echoes the resolved
      `chainId` so `FeaturedMoment` (fetched by address+tokenId, no feed row) can
      drive the mobile card's reads correctly.
- [x] `npm run check` green (typecheck + lint + resource-hints + bundle) + full
      build. Flag **off** → byte-identical to today (every default is Base).

**Explicitly deferred from Phase 2 (correctly out of scope):**
- Write/collect/verify paths stay Base (§10.7): `useDirectCollect`,
  `useCollectAll`, listings, airdrop, `/api/distribute` (+ its creator-verify
  read), `/api/moment/update-uri`, `useMomentSplits`, the intent domain, and the
  `/api/payments` panel (part of the splits/distribute flow). These are Phase 3.
- KV **key** chain-scoping (`trending` / `collected` / `moment-meta` keyed by
  `address:tokenId`): deferred. A same-address-on-both-chains collision is
  improbable (factory deploys differ per chain); revisit with Phase 3 if observed.
- A mainnet card's **collect button** is enabled but Base-targeted until Phase 3 —
  only reachable with the flag on + a registered mainnet collection (test only).

### Phase 3 — Direct on-chain flows multichain (collect / list / buy / admin) ✅ DONE
All user-paid, **no relay dependency**. Every chainId defaults to Base, so the
flag-off behavior is byte-identical.
- [x] `useDirectCollect` / `useCollectAll`: `chainId` arg (collect-all is
      single-collection = single-chain); `ensureChain`; per-call clients via
      `getPublicClient`/`getWalletClient(config, { chainId })`; chain-keyed
      `usdcAddress`/`erc20Minter`; `buildEth/UsdcMintCall({…, chainId})`; record the
      chain. `MomentCard` / `MomentDetailView` / `CollectAllAction` pass the chain;
      the hydrated-collection responses now carry `chainId` so `CollectionRow` /
      `CollectionCard` thread it.
- [x] Listings: **`Listing.chainId`** (legacy-default Base) in `lib/listings.ts`;
      `seaportDomain(chainId)` + `buildSellOrder({…, chainId})` in `ListButton`;
      `BuyButton` / `MarketCard` ensure + read `listing.chainId`. `/api/listings`
      POST validates + stores `chainId`, verifies the order with `seaportDomain` +
      reads royalty/USDC on `serverClient(chainId)`; `/api/listings/[id]` fill
      receipt on `serverClient(listing.chainId)`.
- [x] `/api/collect` + `/api/airdrop/notify` verify the receipt on
      `serverClient(body.chainId)`; the collect hooks + `AirdropForm` send the chain.
- [x] `useAirdrop` (chain in `AirdropRequest`), `useGrantPermission(chainId)`,
      `useAuthorizedCreators(collection, chainId)` + the authorized-creators route
      (admin check on `serverClient(getCollectionChainId)`); `AirdropForm` /
      `CollectionView` pass the collection chain; explorer links via the registry.
- [x] `useMomentSplits`: split-balance **display reads** are chain-aware; the
      **distribute action stays Base** (mainnet distribute deferred, §6.7) — guarded
      with a clear "coming soon" message on a non-Base moment.
- [x] `npm run check` + full build green. Flag off → byte-identical.

**Deferred from Phase 3:** mainnet **distribute** (§6.7 decision — Base-only for
now; the relayed `/api/distribute` + its reads stay Base). Phase 4 = sponsored
mint/deploy + Pass gate. KV key chain-scoping still deferred (improbable collision).

### Phase 4 — Mint + deploy on mainnet (the headline)
Pick **one** mint model for mainnet (see §6 decision):

- **Option A — Extend the sponsored relay** (depends on Phase 0(A)):
  - `MintForm` chain selector → pass `chainId` to `/api/mint` / `/api/write`.
  - `mint-proxy` threads `chainId` upstream; preflight on `serverClient(chainId)`.
  - Intent domain per target chain; EIP-1271 verified on target chain.
  - ⚠️ Platform eats mainnet gas. Add spend caps / per-user quota tuned for L1.
- **Option B — User-paid direct mint on mainnet** (recommended; no relay dep):
  - Build the `createContract` / `setupNewToken` + `callSale` + `adminMint`
    sequence **client-side** (we already have `buildCoverTokenSetupActions` in
    `lib/collections.ts`) and submit from the user's wallet, like deploy/collect.
  - No `INPROCESS_API_KEY` gas exposure; aligns with mainnet user expectations.
  - Trade-off: re-implement the create flow client-side; ensure the resulting
    collection is still indexed by In Process (use their mainnet factory, §1.3).
- [ ] `CreateCollectionForm`: chain selector; deploy via `registry.factory(id)`
      on the chosen chain; `ensureChain`; explorer link; grant ADMIN to the In
      Process smart wallets and **verify on the target chain**.

### Phase 5 — Gate / Pass decision
- [ ] **Recommended:** keep the Pass **Base-only** at launch. The gate check
      (`hasGateAccess`) stays pinned to Base regardless of mint chain; mainnet
      mints are gated by the holder's Base Pass. Document this. (Extending the
      gate to mainnet means a second Alchemy webhook on mainnet + chain-aware
      `pass-validity` — defer.)

### Phase 6 — QA, rollout, monitoring
- [ ] Healthcheck (`lib/healthcheck.ts`) + readiness (`/api/readiness`) cover
      **both** chains (operator ADMIN on a mainnet platform collection iff one
      exists; RPC reachability per chain).
- [ ] Test matrix (§7).
- [ ] Flip `NEXT_PUBLIC_ENABLE_MAINNET` on; ship behind the flag; staged rollout.

---

## 6. Decisions (✅ = confirmed by the team)

1. **Mainnet mint model — sponsored vs user-paid?**
   ✅ **CONFIRMED: user-paid / direct on-chain** for mainnet (Option B). No
   platform L1-gas exposure; no dependency on relay `chainId` support. Base stays
   sponsored. Encoded as `CHAINS[1].sponsoredMint = false`.
2. **Chain-selection UX — per-action selector vs global toggle?**
   *Recommend a **per-action selector*** (a chain chip in MintForm / Create, and
   inferred-from-the-moment for collect/buy/list). A global toggle invites
   wrong-chain mistakes. *(Open — finalize before Phase 4 UI.)*
3. **Curated Discover / `PLATFORM_COLLECTION` on mainnet?**
   *Recommend **creator-collections-only on mainnet at launch*** (no curated
   mainnet platform collection). Discover stays Base-curated; mainnet content
   surfaces through profiles/collections/market. *(Open — revisit at Phase 2.)*
4. **Pass gate on mainnet?** ✅ **CONFIRMED: Base-only Pass.** Encoded as
   `CHAINS[1].gated = false`; the gate check stays Base-pinned (Phase 5).
5. **Treasury recipients on mainnet** (`KISMET_REFERRAL`, `CREATE_REFERRAL`,
   `RESIDENCIES_ADDRESS`) — these are EOAs and work on any chain. *Recommend
   **reuse the same addresses***, but get explicit treasury sign-off (the
   `zoraMint.ts` TREASURY-CRITICAL note applies per chain). *(Open — treasury
   sign-off before Phase 4.)*
6. **Default chain** — ✅ **CONFIRMED: Base stays default**; mainnet is opt-in
   behind `NEXT_PUBLIC_ENABLE_MAINNET`.
7. **Distribute on mainnet** — ✅ **CONFIRMED: user-paid 0xSplits-direct**
   (Option B), designed in §12.7. Base distribute stays relayed/sponsored
   (unchanged). Mainnet calls `SplitMain.distributeETH/ERC20` from the user's
   wallet (permissionless); allocation params are recovered deterministically
   from the stored recipients because we create the split client-side (§12.5.1),
   so there is no param-recovery problem on mainnet. Ships incrementally — the
   Phase 3 "coming soon" guard becomes the `sponsoredMint` branch.

---

## 7. Testing & rollout

- **Unit:** chain registry lookups; `buildEthMintCall`/`buildUsdcMintCall` emit
  mainnet strategy + mainnet USDC for `chainId=1`; seaport/intent domains carry
  the right `chainId`.
- **Integration (testnet first if In Process has a mainnet-like testnet):**
  deploy → mint → collect → list → buy → distribute on chain 1, ETH and USDC.
- **Server verification:** `verifyIntent`, `checkSmartWalletAdmin`,
  `/api/collect`, `/api/listings`, `/api/listings/[id]`, `/api/airdrop/notify`
  read the **correct** chain and fail-closed on mismatch (e.g. a mainnet collect
  receipt must not verify against Base).
- **Cross-chain replay:** a Base mint-intent / Seaport order must **not** be
  fulfillable on mainnet (domain `chainId` binding).
- **Regression:** full Base flow unchanged with the flag **off** and **on**.
- **Rollout:** flag-gated; enable for internal wallets first; watch RPC quota,
  In Process relay errors, and (if Option A) sponsored-gas spend.

---

## 8. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| In Process **create relay** doesn't support mainnet `chainId` | **High** | Phase 0(A); pivot to user-paid Option B |
| **Gas sponsorship** on L1 drains the operator wallet | **High** | Option B (user-paid) for mainnet; spend caps if Option A |
| **Wrong factory** address (§1.3) → silent deploy failure | **High** | Phase 0; verify mainnet `createContract` target before wiring |
| **EIP-1271** intent verify fails for undeployed mainnet smart wallets | Med | ERC-6492 wrap or EOA-sign fallback; verify in Phase 0 |
| **Treasury** constants reused on a new chain without sign-off | Med | Explicit treasury review (§6.5) |
| **Feed fan-out** latency doubles (2 chains) | Med | Cache per chain; consider native multichain timeline |
| **Mixed-chain collect-all** | Low | Group batches by chain; never cross-chain bundle |
| Mainnet RPC under-provisioned (ENS-tier key) | Low | Dedicated higher-quota mainnet key (Phase 1) |
| Listings missing `chainId` (legacy rows) | Low | Default legacy `Listing.chainId` to `8453` (mirrors the `currency='eth'` legacy default) |

---

## 9. Appendix — canonical addresses to encode in `lib/chains.ts`

All values below are EIP-55 checksum-validated and verified against In Process's
`1.json` / `8453.json` (and Circle for USDC). ✅ = present in `lib/chains.ts`.

```
Base (8453)                                                           [in registry]
  fixedPriceStrategy 0x2994762aA0E4C750c51f333C10d81961faEBE785       ✅
  erc20Minter        0xE27d9Dc88dAB82ACa3ebC49895c663C6a0CfA014       ✅
  factory            0x540C18B7f99b3b599c6FeB99964498931c211858       ✅ (docs / current)
  usdc               0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913       ✅
  seaport 1.5        0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC       ✅
  explorer           https://basescan.org                            ✅

Ethereum (1)                                                         [in registry]
  fixedPriceStrategy 0xe0d3febE1c17DDA1086e89B638Ab54955FE2eF8a       ✅
  erc20Minter        0x0676b307D53EA7ED80b20643E1Ac57A78Ce12f87       ✅
  factory            0x2bf5EBEEb028D5F9E02F0F432Ebb1a192F5528F1       ✅ but factoryVerified=false
                     ⚠️ = 1.json FACTORY_PROXY; NOT confirmed as the createContract
                        entrypoint (Base's docs factory 0x540C… ≠ Base FACTORY_PROXY). Verify in Phase 0.
  usdc               0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48       ✅
  seaport 1.5        0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC       ✅
  explorer           https://etherscan.io                            ✅

Chain-agnostic (NOT keyed by chain — kept as existing constants, not in the registry)
  multicall3            0xcA11bde05977b3631167028862bE2a173976CA11   (lib/zoraMint.ts MULTICALL3_ADDRESS)
  KISMET_REFERRAL       0xc6021D9F09e145a6297f64551aa2eCA6d66F8f75   (lib/zoraMint.ts — treasury, confirm)
  OPEN_EDITION_MINT_SIZE 18446744073709551615                        (lib/zoraMint.ts)

0xSplits v1 (for user-paid mainnet split create + distribute — Phase 4 §12)
  SplitMain  0x2ed6c4B5DA6378c7897AC67Ba9e43102Feb694EE   same deterministic addr on Base + mainnet
             ⚠️ mainnet confirmed (etherscan); verify Base deployment + that In Process uses v1
                by inspecting one existing Base split's bytecode. Add to the registry per-chain
                with a `splitsVerified` gate (mirrors factory/factoryVerified). distributorFee = 0.
```

---

## 10. Phase 2 — detailed implementation plan (read model → multichain)

> ✅ **Implemented** (see the Phase 2 DONE checklist in §5 for the as-built
> summary + deferrals). Landed as **dark plumbing** (defaults to Base, zero
> visible change) — same safety posture as Phase 1. Flag-gated by
> `NEXT_PUBLIC_ENABLE_MAINNET`. The §10.6 empirical `chain_id=1` check (10.1)
> still needs a network path to In Process before flipping the flag on.

### 10.1 Dependency findings (In Process docs, verified)
- `/timeline` accepts `collection`, **`chain_id`** (default 8453), `limit`, `page`,
  `artist`, `hidden`, `type`. **One chain per call.**
- `/collections` accepts `artist`, **`chain_id`** (default 8453), `limit`, `page`,
  and **returns each collection's `chainId`** in the response. One chain per call.
- **⚠️ Empirical check (do first, ~5 min):** the docs only document Base. Before
  flipping the flag, confirm `GET /timeline?chain_id=1` and
  `GET /collections?chain_id=1` actually return live mainnet data. If In Process's
  read indexer isn't live on chain 1 yet, Phase 2 still lands safely (Base-default)
  but mainnet feeds stay empty until it is.

### 10.2 Core idea
Every read hardcodes `chain_id=8453` (§3.C). A collection lives on exactly **one**
chain; a moment inherits its collection's chain. So: resolve the chain from the
item for single reads, and query each collection on **its own** chain in the
fan-out. **The fan-out is NOT doubled** — each collection is still one call, just
on the right chain. Only the per-artist profile merge adds one `/collections` call
per enabled chain.

### 10.3 Data model
- Add `chainId?: number` to `CollectionMeta` (`lib/kv.ts`). On read, missing →
  `8453` (legacy = Base), mirroring the `currency='eth'` legacy default in listings.
- Add `getCollectionChainId(address): Promise<number>` (reads collection-meta,
  defaults 8453, cached) — the address→chain resolver for moment/collection routes
  that only have an address in the URL.
- `/api/collections` POST accepts + validates (`isSupportedChainId`) + stores
  `chainId`. Until Phase 4, every deploy is Base so this writes 8453; the plumbing
  is then ready for Phase 4's mainnet deploys with no further read-model work.

### 10.4 Where mainnet content comes from (Phase 2 ↔ Phase 4 coupling)
Our tracked set is all-Base today, so nothing renders on mainnet until a mainnet
collection enters it — which happens when a user deploys on mainnet (Phase 4,
user-paid) or we manually register a known In Process mainnet collection to test.
**Recommendation: land Phase 2 before Phase 4** so mainnet deploys render correctly
from the first one. Test vector in the meantime: hand-register one mainnet In
Process collection and flip the flag in a preview env.

### 10.5 Helpers to (re)introduce here (deferred from Phase 1, now with consumers)
`isMainnetEnabled()`, `enabledChainIds()` (+ add `NEXT_PUBLIC_ENABLE_MAINNET` to
`.env.example`); `getChainOrDefault()`;
`explorerTxUrl()` / `explorerTokenUrl()` (+ `explorerAddressUrl()` only if a
caller needs it).

### 10.6 File-by-file (ordered)
1. `lib/chains.ts` — add the §10.5 helpers.
2. `lib/kv.ts` — `CollectionMeta.chainId`; `getCollectionChainId()`; persist
   chainId in `addTrackedCollection`.
3. `lib/registerCollection.ts` + `app/api/collections/route.ts` (POST) — carry +
   validate + store `chainId`.
4. `lib/inprocess.ts` — `fetchCollectionMoments(addr, { chainId })`; stop
   hardcoding `'8453'`.
5. `app/api/timeline/route.ts` — `fetchCollection(collection, limit, chainId)`;
   resolve each collection's chain via `getCollectionMetaBatch` (default 8453)
   before the fan-out.
6. `lib/momentDetail.ts`, `app/api/moment/route.ts`, `app/api/moment/comments` —
   resolve chain via `getCollectionChainId(address)` (already chainId-param'd).
7. `app/api/collection/route.ts`, `app/collection/[address]/page.tsx` +
   `opengraph-image.tsx` — resolve chain by address.
8. `components/MomentCard.tsx`, `MomentDetailView.tsx`, `CollectionView.tsx` —
   on-chain reads via `usePublicClient({ chainId: moment.chain_id })`; explorer
   links via `explorerTxUrl/TokenUrl`.
9. `app/api/featured/collections-hydrated`, `lib/coverMomentSynthesis.ts`,
   `lib/collectionCache.ts`, `lib/search.ts` — thread chainId.
10. `app/api/collections` GET `?artist` — merge In Process `/collections` across
    `enabledChainIds()` (response carries each row's `chainId`) + the KV fallback.

### 10.7 Out of scope for Phase 2 (stays Base until Phase 3)
Server-side **write/verify** reads — collect receipt, distribute, listings royalty
+ fill, airdrop receipt — stay on `serverBaseClient()` (Base). Phase 2 is
read-only display + feeds; Phase 3 chain-parameterizes those via
`serverClient(chainId)`.

### 10.8 Testing
- Flag **off**: byte-identical to today (every default is 8453).
- Flag **on** + one hand-registered mainnet collection: it appears in feeds, its
  moments render, explorer links go to etherscan; collect/list still Base-only.
- Empirical: `/timeline?chain_id=1` returns data.

### 10.9 Risks
- Moment-detail chain resolution adds a KV read per detail page → cache
  `getCollectionChainId`; fallback for unknown addresses = try Base then mainnet
  (≤2 upstream calls).
- Fan-out latency unchanged (one call per collection, on its chain) — not doubled.

---

## 11. Phase 3 — detailed implementation plan (direct on-chain flows → multichain)

> ✅ **Implemented** (see the Phase 3 DONE checklist in §5 for the as-built
> summary). Scope: **collect / collect-all / list / buy / cancel / airdrop /
> grant** — all user-paid, direct on-chain (no relay). Distribute was **deferred**
> per the §6.7 decision (the §11.6 fork → Option C). Every chainId defaults to
> Base; with the flag off behavior is byte-identical.

### 11.1 chainId propagation (mostly already wired by Phase 2)
- **Moment-scoped** flows read `momentChainId` (already in `MomentCard`,
  `MomentDetailView`, `FeaturedMoment`): collect, list, splits/distribute.
- **Collection-scoped** flows read the page-resolved `chainId` (already a
  `CollectionView` prop): airdrop, grant, collect-all.
- **Listing-scoped** flows read `listing.chainId` (new field, §11.2): buy, cancel.

### 11.2 Data model
- Add `chainId?: number` to the `Listing` interface (`lib/listings.ts`).
  `createListing` accepts it; `getListing` / `getListingsBatch` default missing →
  Base (mirrors the existing `currency='eth'` legacy default).
- `/api/listings` POST validates (`isSupportedChainId`) + stores `chainId`.

### 11.3 Client hooks/components (swap `useEnsureBase`→`useEnsureChain`, pin chainId)
- `hooks/useDirectCollect.ts` — add `chainId` to `CollectArgs`; `ensureChain(id)`;
  `usePublicClient({ chainId })`; `buildEthMintCall/{Usdc}({…, chainId})`;
  `usdcAddress(id)` + `erc20Minter(id)` for the USDC allowance/approve/mint;
  record `chainId`. `MomentCard` / `MomentDetailView` pass `momentChainId`.
- `hooks/useCollectAll.ts` — add `chainId` to `CollectAllArgs`; pin
  `publicClient`/`walletClient`/`sendCallsAsync`/`writeContractAsync` to it; the
  `getAccount(config).chainId !== base.id` guard → `!== chainId`;
  `walletClient.sendTransaction({ chain: getChain(id).chain })`; `usdcAddress(id)`,
  `erc20Minter(id)` (MULTICALL3 is chain-agnostic). Single-collection invocation =
  single chain, so no cross-chain batching problem. `CollectAllAction` passes the
  collection's chain (surface `chainId` on the hydrated-collection payload).
- `components/ListButton.tsx` — `chainId` prop; `ensureChain`; `seaportDomain(id)`
  for the signature; `buildSellOrder({…, chainId})`; pinned writes/reads; POST
  includes `chainId`.
- `components/BuyButton.tsx` + `components/MarketCard.tsx` — derive chain from
  `listing.chainId`; `ensureChain`; `usdcAddress(id)`; pinned `fulfillOrder` /
  `cancel` writes + receipt reads.
- `hooks/useAirdrop.ts` — `chainId` in `AirdropRequest`; `ensureChain`; pinned
  `adminMint`/multicall writes. `AirdropForm` passes the collection chain + posts
  `chainId` to `/api/airdrop/notify`.
- `hooks/useGrantPermission.ts` — `chainId` param; `usePublicClient({ chainId })`,
  `useWaitForTransactionReceipt({ chainId })`, `ensureChain`, pinned writes.
  `CollectionView` / `AirdropForm` / `MomentDetailView` pass the collection chain.
- Explorer links in these surfaces (airdrop/grant/collect toasts) → registry
  `explorerTxUrl(chainId, …)`.

### 11.4 Server verification (→ `serverClient(chainId)`)
- `/api/collect` — `verifyMintOnChain` + `readSalePricePerToken` on
  `serverClient(body.moment.chainId)` (client already sends it; generalize from
  `base.id`).
- `/api/listings` POST — `verifyRoyalty` on `serverClient(chainId)`; signature
  verify with `seaportDomain(chainId)`; `validateOrderShape` USDC token →
  `usdcAddress(chainId)`.
- `/api/listings/[id]` PATCH — fill-receipt read on `serverClient(listing.chainId)`
  (`findFulfillmentInLogs` is domain-agnostic — no change).
- `/api/airdrop/notify` — `verifyAirdropOnChain` on `serverClient(body.chainId)`.
- `/api/collection/authorized-creators` — perms reads on the collection's chain
  (grant flow).

### 11.5 EIP-1271 caveat (listings)
The listing signature is verified server-side with `verifyTypedData` via
`serverClient(listing.chainId)`. A seller using a smart wallet that isn't yet
deployed on mainnet would fail ERC-1271 verification — same counterfactual-wallet
caveat as the Phase 4 intent path (§0). Mitigate with ERC-6492 or require the
order be EOA-signed on mainnet. Verify in Phase 0.

### 11.6 ⚠️ Decision — distribute on mainnet (the one relayed flow)
`/api/distribute` relays through In Process (sponsored) with `chainId`.
`useMomentSplits` display reads (balance via `useBalance({ chainId })` /
`usdcAddress(id)`) are trivially chain-aware, but the distribute **action** forks:
- **Option A — relay** (send `chainId: 1` to In Process `/distribute`): depends on
  their relay supporting mainnet — the same unknown as the mint relay.
- **Option B — user-paid 0xSplits-direct** (recommended, consistent with the
  mint decision): call the split contract's `distribute` from the user's wallet
  (0xSplits distribution is permissionless). Needs the per-chain 0xSplits
  `SplitMain`/distribute ABI; no relay dependency, no platform gas.
- **Option C — defer:** keep distribute Base-only for Phase 3 (display reads
  multichain), ship mainnet distribute as a fast-follow. Distribution is a
  late-lifecycle action, so this is low-impact.
Recommend **B**, or **C** if we want to ship Phase 3 without the 0xSplits-direct
work.

### 11.7 Out of scope (Phase 4)
Sponsored mint + deploy on mainnet (`MintForm` / `CreateCollectionForm` /
`mint-proxy` / intent domain) and the Pass gate. Phase 3 leaves those Base-only.

### 11.8 KV key chain-scoping (revisit)
`trending` / `collected` / `moment-meta` / collect+airdrop idempotency keys are
`address:tokenId`. Phase 3 is where the collect/airdrop **recording** could append
chain to these keys if a same-address-cross-chain collision is ever observed
(improbable — factory deploys differ per chain). Recommend leaving as-is unless
observed; if changed, do it once across all four key families with a default-Base
read shim.

### 11.9 Testing
- Flag off: byte-identical (every default is Base).
- Flag on + a registered mainnet collection: collect (ETH + USDC), collect-all,
  list, buy, cancel, airdrop, grant all execute on chain 1 with the mainnet
  strategy/USDC addresses; server verification reads chain 1; a Base order can't
  be filled on mainnet (domain `chainId` binding) and vice-versa.
- Mixed feed: a Base card and a mainnet card on the same page each collect on
  their own chain (wallet prompts the right switch).

### 11.10 Risks
- Distribute relay (§11.6) — pick B/C to avoid the relay dependency.
- EIP-1271 on mainnet for undeployed smart-wallet sellers (§11.5).
- Mainnet gas is user-paid (expected) but higher — surface it in the UX
  (collect/airdrop confirm copy).
- Per-chain `serverClient` RPC quota on mainnet (provision a real key).

---

## 12. Phase 4 — detailed plan (user-paid mainnet: deploy, mint, splits, distribute)

> **Principle (same posture as Phases 1–3):** Base is untouched — every relayed
> Base flow stays exactly as-is. Each change is *additive* or branches once on
> `getChain(chainId).sponsoredMint` (Base `true` → relay; mainnet `false` →
> client-side, user-paid). Flag-gated by `NEXT_PUBLIC_ENABLE_MAINNET`.
> **As-built (this branch):** the user-paid mainnet vertical — **image** mint into an
> existing collection, the Phase-3 flows (collect / list / buy / airdrop / grant), and
> split distribute/withdraw — is implemented and `npm run check`-green. Three writes
> remain **deferred on mainnet** (still Base-relay only, UI-gated off there): **deploy
> (§12.4), text/write moments, and update-URI.** All Base-safe: every path defaults to
> Base and is reachable only behind `NEXT_PUBLIC_ENABLE_MAINNET` / `splitsVerified`
> / `factoryVerified`. Not yet exercised on-chain (no test runner; unreachable
> until a mainnet collection exists — i.e. until deploy + the factory land) — and,
> per the 2026-06-05 In Process reply, **not renderable until their REST API serves
> `chain_id=1`** (§12.10).
> - ✅ **Mint engine + MintForm wiring:** `useClientMint` + `buildMomentMintActions`
>   (ETH **and** USDC, client-side 0xSplits `createSplit` wiring the split as
>   fundsRecipient + royalty recipient, idempotent, re-entrance-latched). MintForm
>   branches on `sponsoredMint`: mainnet mints client-side + `POST /api/mint/record`;
>   Base relay path unchanged.
> - ✅ **`/api/mint/record`:** records moment-meta + splits for user-paid mints
>   (on-chain verified: token exists, creator holds it, split matches
>   `getCreatorRewardRecipient`; blacklist + pause enforced).
> - ✅ **Distribute + withdraw (user-paid):** `useMomentSplits` branches on
>   `sponsoredMint` — mainnet calls `SplitMain.distributeETH/ERC20` then `withdraw`
>   directly (gated by `splitsVerified`); Base relay unchanged. Foundation in
>   `lib/splitMain.ts` + `lib/chains.ts` (`splitMain`, `splitsVerified`).
> - ✅ **Chain selector + logos:** `components/ChainIcon` (Base square / Ethereum
>   diamond) + a chain chip by the price-currency toggle in MintForm.
> - ⬜ **Deploy on mainnet (§12.4):** deferred to flip-day — the deploy flow is
>   deeply Base-coupled (required In Process smart-wallet lookup, the
>   `verifyDeployPermissions` receipt-watcher, operator ADMIN grants) and fully
>   blocked on the unconfirmed factory, so it ships as one testable unit once the
>   factory's confirmed rather than untested surgery now.
> - ⬜ **Text/write moments on mainnet:** the `useClientMint` engine is URI-agnostic
>   (it already handles text), but MintForm gates text off on mainnet ("coming soon").
>   Unblock is a one-line UI change once deploy lands.
> - ⬜ **Update-URI on mainnet:** `MomentDetailView` still POSTs the edit to the Base
>   relay (`chainId: 8453` hardcoded, :858); the client-side `updateTokenURI` (§12.6)
>   is not wired yet. Unreachable today (no mainnet moments) and Base-safe.

### 12.1 Every mainnet action, by status
| Action | Base (unchanged) | Mainnet today | Mainnet plan |
|---|---|---|---|
| collect / collect-all | user-paid | ✅ done (Ph3) | — |
| list / buy / cancel | user-paid | ✅ done (Ph3) | — |
| airdrop / grant | user-paid | ✅ done (Ph3) | — |
| **deploy** | user-paid | blocked | verify factory (§1.3) + chain selector — §12.4 |
| **mint (image)** | relay | — | `useClientMint` + split-create + USDC + record — §12.5 |
| **write (text)** | relay | — | same engine, text URI — §12.5 |
| **update-URI** | relay | — | direct `updateTokenURI` — §12.6 |
| **create split** | In Process | — | client `SplitMain.createSplit` — §12.5.1 |
| **distribute** | relay | "coming soon" | client `SplitMain.distributeETH/ERC20` — §12.7 |
| **withdraw split** | relay (implicit) | — | client `SplitMain.withdraw` — §12.7 |

Six of nine flows already run on mainnet (Phase 3). The remaining four — deploy,
mint/write, update-URI, distribute/withdraw — are the user-paid build, all
client-side direct-to-chain (no relay).

### 12.2 The branch (one conditional per sponsored flow)
`sponsoredMint` already encodes the decision. At each relayed call site:
```
if (getChain(chainId).sponsoredMint) {   // Base
  await fetch('/api/mint', …)             // existing relay — untouched
} else {                                  // mainnet
  await clientMint(…)                      // useClientMint
}
```
Same shape for write / update-URI / distribute. Base path byte-for-byte unchanged.

### 12.3 Registry additions (`lib/chains.ts`)
Add the 0xSplits singleton + a verified gate, mirroring `factory`/`factoryVerified`:
```
splitMain:      '0x2ed6c4B5DA6378c7897AC67Ba9e43102Feb694EE'  // v1, same on both chains
splitsVerified: boolean   // false until confirmed on-chain (§12.10)
```
- 0xSplits **v1 `SplitMain`** is the same deterministic address on Base + mainnet
  (mainnet confirmed on etherscan). Verify the Base deployment **and** that
  In Process uses v1 by inspecting one existing Base split's bytecode (§12.10).
- `DISTRIBUTOR_FEE = 0` (chain-agnostic const) — In Process creates fee-less
  splits; matching keeps allocations exactly `pct × 10_000` (§12.7).

### 12.4 Deploy (`CreateCollectionForm`) — blocked on §1.3
- Chain selector → deploy via `getChain(id).factory`; `ensureChain`; explorer on
  the chosen chain. Code is small; **gated on `factoryVerified` flipping true** —
  the mainnet `createContract` entrypoint is still unconfirmed (§1.3).
- **Simpler than Base:** *skip* the operator-smart-wallet ADMIN grant — there is
  no relay to authorize on mainnet. The deployer is `defaultAdmin`, which is
  exactly the authority `setupNewToken` needs for the client mint (§12.5). A
  self-deployed mainnet collection is mintable by its creator with no extra grant.
- Deploy is the **prerequisite** for mainnet mint: until it ships there are no
  In-Process-style mainnet collections to mint into.

### 12.5 Mint (image) + Write (text) — `useClientMint`
Engine landed: `buildMomentMintActions` → `multicall([assumeLastTokenId,
setupNewToken, addPermission(MINTER→strategy), setSale, adminMint])`, user-paid.
What the relay did for free that the client path must reproduce:

**12.5.1 Create the split — the one genuinely new on-chain step.**
On Base, In Process creates the 0xSplits split and wires it as the payout. On
mainnet, before the mint multicall:
1. `validateSplitsArray` (existing) → sorted `accounts[]`, integer `pct[]`
   summing to 100.
2. `SplitMain.createSplit(accounts, pct.map(p => p*10_000), 0 /*fee*/,
   0x0 /*controller = immutable*/)` from the user's wallet → `splitAddr`.
   (`pct × 10_000` is exact: 100 × 10 000 = 1e6 = `PERCENTAGE_SCALE`, no remainder.)
3. Pass `splitAddr` as `fundsRecipient` in the mint's `setSale` (sale proceeds →
   split). To mirror Base fully (creator-reward + secondary royalties → split),
   also append `updateRoyaltiesForToken(tokenId, {recipient: splitAddr, …})` to
   the multicall — optional for MVP (primary sale proceeds are the bulk).
4. **Payoff:** because *we* created it with these exact params, distribute (§12.7)
   needs no param recovery — it is deterministic from the stored recipients.
   0/1-recipient moments skip the split: `fundsRecipient = creator`.

**12.5.2 USDC path.** `buildMomentMintActions` is ETH/FixedPrice. USDC needs the
`ERC20Minter.setSale(tokenId, {…, currency: usdc, pricePerToken})` write encoding
(we have only the *read* ABI in `lib/saleConfig.ts`). Add the fragment + a
currency branch in the builder. The collect side already does USDC on both chains.

**12.5.3 Recording / indexing.** The relay records moment-meta, registers the
collection, and In Process indexes it. Client-side mainnet must do the first two
itself — a new `POST /api/mint/record` (or an extended recorder) that, after the
multicall receipt, writes:
- `setStoredSplits(collection, tokenId, recipients)` + `splitAddr` + `chainId`
  (extend `lib/splits.ts` value shape *additively* — distribute reads it back).
- `moment-meta` (creator EOA, name, price, currency, chainId) — the same KV the
  distribute + notification paths already read.
- `POST /api/collections` (Phase 2) to register the collection as tracked on
  chain 1 so the read model queries it.
- Feed visibility still depends on **In Process indexing chain 1** (§12.10 / §10.1).

**12.5.4 Gates.** `mint-proxy` gates are bypassed when the relay is skipped:
- **Intent / EIP-712:** *unneeded* on mainnet — the user signs the real tx, which
  *is* the auth. The `KISMET_INTENT_DOMAIN` chain-pinning issue disappears.
- **Pass:** Base-only by decision #4 — N/A.
- **Blacklist / pause / quota:** these protect *sponsored* gas. On user-paid
  mainnet the minter pays their own gas, so the abuse calculus differs. We
  **cannot** block a permissionless on-chain mint, but we **can** refuse to
  index/surface it — enforce blacklist + pause at `/api/mint/record`. Honest
  limitation: mainnet moderation is index-level, not chain-level (§12.9).

### 12.6 Update token URI — client-side
`PATCH /moment` relay → direct `updateTokenURI(tokenId, newURI)` on the collection
(caller holds ADMIN). Small new hook; low priority (metadata edits are rare).

### 12.7 Distribute + withdraw — client-side (`useMomentSplits`)
Display reads are already chain-aware. Replace the `chainId !== BASE_CHAIN_ID`
"coming soon" guard (`useMomentSplits.ts:142`) with a `sponsoredMint` branch:
- **Base:** existing signed `POST /api/distribute` relay — untouched.
- **Mainnet (user-paid):**
  1. `ensureChain(chainId)`.
  2. Recover params from stored recipients: `accounts = sorted addresses`,
     `allocations = pct × 10_000`, `distributorFee = 0` (deterministic, §12.5.1).
  3. `SplitMain.distributeETH(split, accounts, allocations, 0, distributorAddr)`
     for ETH; `distributeERC20(split, usdc, accounts, allocations, 0,
     distributorAddr)` for USDC. **Permissionless** — whoever clicks (recipient /
     creator / admin) pays the gas; funds still flow only to the fixed recipients.
- **Withdraw (the second hop):** `distributeETH` moves funds from the split clone
  into each recipient's *internal* SplitMain balance; recipients pull to their
  wallet via `SplitMain.withdraw(account, withdrawETH=1, [usdc?])`. On Base this is
  cheap/relayed; on mainnet each recipient pays their own withdraw. Surface a
  per-recipient "Withdraw" action (read `getETHBalance`/`getERC20Balance(account)`
  on SplitMain for what's claimable).
- **Base splits stay on the relay**, so no param recovery for In-Process-created
  splits is ever needed (their scaling/fee is theirs, not ours).

### 12.8 Chain-selector UX (decision #2)
Per-action chip in `MintForm` / `CreateCollectionForm` (not a global toggle —
avoids wrong-chain mints). Collect / buy / list / distribute infer the chain from
the moment (already wired). The chip drives the `sponsoredMint` branch + `ensureChain`.

### 12.9 Moderation on user-paid mainnet
- We can't prevent a permissionless mint; moderation is **index-level** (refuse to
  track/surface). Acceptable: an un-indexed mainnet moment is invisible in-app.
- No platform gas to bound → drop the quota on the mainnet path; keep
  blacklist/pause at the recorder.
- Treasury EOAs (`KISMET_REFERRAL` / `CREATE_REFERRAL`) work on any chain — passed
  client-side as today; treasury sign-off (#5) still applies.

### 12.10 Phase 0 blockers (confirm before flipping the flag)
> **Researched `sweetmantech/in-process-protocol` (2026-06):** In Process's full
> 1155 protocol **IS deployed on Ethereum mainnet** (`addresses/1.json`, ~2026-05;
> 12 chains total). Our registry strategies are verified against it
> (`FIXED_PRICE_SALE_STRATEGY 0xe0d3…`, `ERC20_MINTER 0x0676…`). This flips the
> keystone from "unknown" to **yes** — see the per-blocker updates below.
>
> **⛔ Update (2026-06-05, direct from In Process team):** *"We are supporting
> indexer. but API is not yet."* → their on-chain **indexer follows mainnet**, but
> the **REST API (`api.inprocess.world`) does NOT serve `chain_id=1` yet.** Our
> read model is **100% REST-API** (`/timeline`, `/collection`, `/collections`,
> `/moment`, `/comments`, `/payments`), so **mainnet content is invisible in-app
> until their API ships chain 1** — regardless of the factory or a successful
> deploy. **This, not the factory, is now the critical-path gate, with an ETA that
> is upstream (not ours to control).** Posture is unchanged: flag off, branch
> dormant, code green.

1. **Mainnet `createContract` factory** (§1.3) — gates deploy → gates everything.
   The factory their **indexer** watches is still unresolved, and the repo proves
   the caution is warranted: In Process's production *Base* factory (`0x540C…`,
   what our indexed deploys use) matches **neither** their `8453.json` FACTORY_PROXY
   (`0x4c6b…`) **nor** their `creator-subgraph` config (upstream Zora `0x777777…`
   addresses). So the mainnet FACTORY_PROXY (`0x2bf5…`) **cannot be assumed** to be
   the indexed factory. Resolve empirically (test-deploy via `0x2bf5…` →
   `GET /timeline?chain_id=1`) or ask In Process for the mainnet factory their API
   indexes. `factoryVerified=false` stays correct.
2. **In Process serves chain 1** (§10.1) — **resolved by the 2026-06-05 reply:
   indexer = ✅ yes; REST API = ❌ not yet.** Because our read model reads the API
   (not the indexer), the **API half gates feed visibility — and it's open upstream
   with no ETA.** A subgraph-direct read model could bypass the API but is a large
   parallel build, throwaway once their API ships chain 1 — not worth it for
   uncertain demand. **This is now the top blocker.**
3. **0xSplits SplitMain** — `0x2ed6…694EE` is **etherscan-confirmed on mainnet**;
   we mint v1 splits ourselves so the version is our choice. Flip `splitsVerified`
   once a mainnet split exists to distribute (i.e. after the mint path is wired).
4. **EIP-1271 / listings** (§11.5) — undeployed smart-wallet sellers on mainnet.
5. **(Optional) In Process mainnet relay/paymaster roadmap** — if yes, sponsored
   mainnet becomes free later (Option A) with no rework.

### 12.11 Testing
- Flag off: byte-identical (every default Base; nothing calls the client mint).
- Flag on + verified mainnet collection: deploy → mint (ETH + USDC, with + without
  splits) → collect → distribute → withdraw, all on chain 1, user-paid; the split
  created client-side distributes with no relay; KV-stored recipients reconstruct
  the exact on-chain allocations.
- Base unchanged: mint/distribute still relay; a Base split still distributes via
  In Process.

### 12.12 Open questions
- Creator-reward/royalty recipient → split on mainnet (full Base parity) vs
  sale-proceeds-only for MVP? (§12.5.1 step 3.)
- Resolve `splitAddress` on mainnet from KV (we stored it) vs on-chain
  `getCreatorRewardRecipient` (only if we also set it). Recommend KV.
- One recorder endpoint for image+text+mainnet, or extend `mint-proxy`?

### 12.13 Documentation alignment (verified against In Process docs, 2026-06)
Researched `github.com/sweetmantech/docs-in-process` (the hosted `docs.inprocess.world`
is bot-blocked — the repo is the source of truth). The design is aligned;
verifications and refinements below.

**Confirmed**
- **Create wires the split exactly as §12.5.1 plans.** `POST /api/moment/create`
  (no API key, no signature) accepts a `splits[]` array (min 2, sum 100% — matches
  `validateSplitsArray`) and, per the docs, "creates and deploys a splits contract,
  automatically setting it as the payout recipient." Client-side mainnet reproduces
  this one step: `createSplit` → set the split as `fundsRecipient`/payoutRecipient.
- **The relay is Base-hardwired → Option A is impossible for mint.** `/moment/create`
  takes **no `chainId`**; its response is fixed `chainId: 8453`. In Process *cannot*
  mint on mainnet even if asked — so decision #1 (user-paid, Option B) is the only
  path, a constraint not a preference. Same for the text variant
  `/moment/create/writing` (confirmed to exist).
- **createContract payload matches our `FACTORY_ABI`** (contractURI, name,
  defaultRoyaltyConfiguration{royaltyMintSchedule,royaltyBPS,royaltyRecipient},
  defaultAdmin, setupActions[]). In Process makes the *smart wallet* the
  defaultAdmin+royaltyRecipient; Kismet makes the *user* defaultAdmin — our
  divergence is intentional and is exactly what lets a mainnet creator self-mint
  (§12.4) with no smart-wallet grant.
- **`updateRoyaltiesForToken` is the royalty-recipient mechanism** (setup-actions
  doc) — confirms §12.5.1 step 3 (point secondary royalties + creator rewards at the
  split via this call). Documented setup order: setupNewToken → updateTokenURI →
  updateRoyaltiesForToken → setSale; `addPermission` grants the strategy MINTER.
- **Read API is multichain-shaped.** `/timeline?chain_id=` (default 8453) and
  `/collection?chainId=` (default 8453) both return `chain_id` per item. Our code
  already mirrors the docs' *inconsistent* casing (`/timeline`,`/collections` →
  `chain_id`; `/collection` → `chainId`) — verified in-code, no bug.

**Refinements**
- **Distribute DOES take `chainId` (default 8453); create does not.** Unlike mint,
  distribute has a *theoretical* relay path on mainnet (Option A) — but it'd be
  sponsored (their gas) and In Process has no mainnet deployment, so Option B
  (user-paid 0xSplits-direct, §12.7) stands.
- **The docs never name 0xSplits / SplitMain / a version.** Blocker #3 cannot be
  closed from docs — it requires inspecting one live Base split's bytecode on-chain.

**External unknowns the docs CONFIRM are still open (gate the flag)**
1. `protocol-deployments.mdx` lists **only Base + Base Sepolia** — no mainnet
   factory. `factoryVerified=false` is correct; must ask In Process (blocker #1).
2. The read API accepts `chain_id` but the docs **nowhere confirm chainId 1 is
   indexed/live** — the §10.1 empirical `GET /timeline?chain_id=1` check is THE gate
   (blocker #2).
3. 0xSplits version unconfirmed by docs (blocker #3 — on-chain inspection).
