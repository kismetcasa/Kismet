import { base, mainnet } from 'viem/chains'
import type { Address, Chain } from 'viem'

/**
 * Chain registry — the single source of truth for every chain-specific fact:
 * In Process / Zora protocol contract addresses, currency tokens, the
 * marketplace (Seaport) deployment, explorer hosts, and RPC env resolution.
 *
 * Everything that used to hardcode `8453`, `base`, a contract address, or
 * `basescan.org` should read from here instead. See MAINNET_EXPANSION_SCOPE.md.
 *
 * Capability flags encode the confirmed product decisions:
 *   - `sponsoredMint`: Base mints go through the gasless In Process relay; mainnet
 *     mints are USER-PAID (direct on-chain) — the platform never sponsors L1 gas.
 *   - `gated`: the Creator Pass gate is Base-only at launch.
 *   - `factoryVerified`: the deploy path must not target a chain whose
 *     `createContract` factory hasn't been confirmed (see §1.3 of the scope doc).
 */

export type SupportedChainId = typeof base.id | typeof mainnet.id // 8453 | 1

export const BASE_CHAIN_ID: SupportedChainId = base.id
export const MAINNET_CHAIN_ID: SupportedChainId = mainnet.id

/** The platform's primary chain. Every chain-parameterized helper defaults to
 *  this so Base behavior is unchanged until a caller passes another chain. */
export const DEFAULT_CHAIN_ID: SupportedChainId = BASE_CHAIN_ID

export interface ChainConfig {
  chainId: SupportedChainId
  chain: Chain
  label: string

  // ── In Process / Zora 1155 protocol (per chain — these differ on mainnet) ──
  /** In Process FixedPriceSaleStrategy (ETH sales). */
  fixedPriceStrategy: Address
  /** In Process / Zora ERC20Minter (USDC sales). */
  erc20Minter: Address
  /**
   * `createContract` factory entrypoint. This is the address In Process's docs
   * publish for integrators (the Base value `0x540C18B7…` is what the current
   * deploy path calls) — NOT necessarily the `FACTORY_PROXY` in their
   * 1155-deployments JSON. `factoryVerified` gates the deploy path.
   */
  factory: Address
  /** True only once the `factory` above is confirmed for this chain. */
  factoryVerified: boolean

  // ── Currencies (per chain) ──
  /** Canonical USDC (6 decimals on both chains). */
  usdc: Address

  // ── Marketplace ──
  /** Seaport 1.5 (same deterministic address on every chain; the EIP-712
   *  domain `chainId` is what differs — see `seaportDomain`). */
  seaport: Address

  // ── Splits (0xSplits v1 SplitMain) ──
  /** 0xSplits v1 SplitMain singleton — same deterministic address on every
   *  chain. Used ONLY on user-paid chains (we create + distribute the split
   *  client-side and own its params). Base splits go through the In Process
   *  relay and never touch this address. */
  splitMain: Address
  /** True once SplitMain is confirmed on-chain for this chain. Gates the
   *  user-paid distribute path (`useMomentSplits`); Base is unaffected (relay). */
  splitsVerified: boolean

  // ── Capability flags (product decisions) ──
  /** Base: gasless relay. Mainnet: false (user-paid direct on-chain). */
  sponsoredMint: boolean
  /** Creator Pass gate applies on this chain? Base: true. Mainnet: false. */
  gated: boolean

  // ── Explorer ──
  explorer: string
}

// Seaport 1.5 — same deterministic address on every chain.
const SEAPORT_1_5: Address = '0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC'

// 0xSplits v1 SplitMain — same deterministic CREATE2 address on every chain
// (Ethereum mainnet confirmed on etherscan; Base shares it). See lib/splitMain.ts.
const SPLIT_MAIN_V1: Address = '0x2ed6c4B5DA6378c7897AC67Ba9e43102Feb694EE'

export const CHAINS: Record<SupportedChainId, ChainConfig> = {
  [BASE_CHAIN_ID]: {
    chainId: BASE_CHAIN_ID,
    chain: base,
    label: 'Base',
    fixedPriceStrategy: '0x2994762aA0E4C750c51f333C10d81961faEBE785',
    erc20Minter: '0xE27d9Dc88dAB82ACa3ebC49895c663C6a0CfA014',
    factory: '0x540C18B7f99b3b599c6FeB99964498931c211858',
    factoryVerified: true,
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    seaport: SEAPORT_1_5,
    splitMain: SPLIT_MAIN_V1,
    splitsVerified: false, // Base uses the relay for distribute; flag unused here
    sponsoredMint: true,
    gated: true,
    explorer: 'https://basescan.org',
  },
  [MAINNET_CHAIN_ID]: {
    chainId: MAINNET_CHAIN_ID,
    chain: mainnet,
    label: 'Ethereum',
    // ✅ Verified against in-process-protocol/addresses/1.json — In Process's full
    // 1155 protocol IS deployed on Ethereum mainnet (~2026-05).
    fixedPriceStrategy: '0xe0d3febE1c17DDA1086e89B638Ab54955FE2eF8a',
    erc20Minter: '0x0676b307D53EA7ED80b20643E1Ac57A78Ce12f87',
    // ⚠️ = 1.json FACTORY_PROXY, still UNVERIFIED *for indexing*. The Base
    // precedent proves we can't assume it: In Process's production Base factory
    // (0x540C…, what our indexed deploys call) matches NEITHER their 8453.json
    // FACTORY_PROXY (0x4c6b…) NOR their creator-subgraph config — so 0x2bf5… is
    // not safe to assume as the factory their API indexes on mainnet. Resolve via
    // test-deploy → GET /timeline?chain_id=1, or ask In Process. See scope §12.10.
    factory: '0x2bf5EBEEb028D5F9E02F0F432Ebb1a192F5528F1',
    factoryVerified: false,
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    seaport: SEAPORT_1_5,
    splitMain: SPLIT_MAIN_V1,
    // ⚠️ false until SplitMain v1 is confirmed on-chain (mainnet is etherscan-
    // verified; flip to true after confirming + that we create v1 splits). Gates
    // the user-paid distribute path in useMomentSplits.
    splitsVerified: false,
    sponsoredMint: false,
    gated: false,
    explorer: 'https://etherscan.io',
  },
}

export function isSupportedChainId(id: number | undefined | null): id is SupportedChainId {
  return id === BASE_CHAIN_ID || id === MAINNET_CHAIN_ID
}

/** Strict lookup — throws on an unsupported chain. Use where a bad chain is a
 *  programming error (mint/collect/deploy paths). */
export function getChain(id: number): ChainConfig {
  if (!isSupportedChainId(id)) {
    throw new Error(`Unsupported chainId: ${id}`)
  }
  return CHAINS[id]
}

/** Tolerant lookup — falls back to the default chain. Use for display / render
 *  paths that may receive a stale or missing `chain_id` and should degrade
 *  gracefully rather than throw (explorer links, feed rendering). */
export function getChainOrDefault(id: number | string | undefined | null): ChainConfig {
  const n = typeof id === 'string' ? Number(id) : id
  return isSupportedChainId(n) ? CHAINS[n] : CHAINS[DEFAULT_CHAIN_ID]
}

// ── Enablement (read-model fan-out gating) ───────────────────────────────────

/** Mainnet ships behind a flag so the read model fans out across chains only
 *  when explicitly enabled. Default off → Base-only (current behavior). */
export function isMainnetEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ENABLE_MAINNET === 'true'
}

/** Chains the app currently reads/fans out across. Base always; mainnet only
 *  when the flag is on. Used to gate which tracked collections are queried. */
export function enabledChainIds(): SupportedChainId[] {
  return isMainnetEnabled() ? [BASE_CHAIN_ID, MAINNET_CHAIN_ID] : [BASE_CHAIN_ID]
}

/** True when `chainId` is one the app should currently surface. A
 *  missing/legacy chain (undefined) is treated as Base. */
export function isChainEnabled(chainId: number | undefined | null): boolean {
  const id = chainId ?? DEFAULT_CHAIN_ID
  return enabledChainIds().includes(id as SupportedChainId)
}

// ── Explorer URL builders ────────────────────────────────────────────────────

export function explorerTxUrl(chainId: number, hash: string): string {
  return `${getChainOrDefault(chainId).explorer}/tx/${hash}`
}

export function explorerTokenUrl(chainId: number, address: string, tokenId?: string): string {
  const url = `${getChainOrDefault(chainId).explorer}/token/${address}`
  return tokenId ? `${url}?a=${tokenId}` : url
}

// ── RPC resolution ─────────────────────────────────────────────────────────

/** Client-safe public RPC URL (NEXT_PUBLIC_* — inlined into the bundle). */
export function publicRpcUrl(chainId: number): string | undefined {
  switch (chainId) {
    case BASE_CHAIN_ID:
      return process.env.NEXT_PUBLIC_BASE_RPC_URL
    case MAINNET_CHAIN_ID:
      return process.env.NEXT_PUBLIC_MAINNET_RPC_URL
    default:
      return undefined
  }
}

/** Server-only RPC URL — prefers a server var, falls back to the public one.
 *  Mirrors the existing lib/rpc.ts precedence so the paid key driving server
 *  reads isn't necessarily the one inlined into the client bundle. */
export function serverRpcUrl(chainId: number): string | undefined {
  switch (chainId) {
    case BASE_CHAIN_ID:
      return process.env.BASE_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL
    case MAINNET_CHAIN_ID:
      return process.env.MAINNET_RPC_URL || process.env.NEXT_PUBLIC_MAINNET_RPC_URL
    default:
      return undefined
  }
}
