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
    sponsoredMint: true,
    gated: true,
    explorer: 'https://basescan.org',
  },
  [MAINNET_CHAIN_ID]: {
    chainId: MAINNET_CHAIN_ID,
    chain: mainnet,
    label: 'Ethereum',
    fixedPriceStrategy: '0xe0d3febE1c17DDA1086e89B638Ab54955FE2eF8a',
    erc20Minter: '0x0676b307D53EA7ED80b20643E1Ac57A78Ce12f87',
    // ⚠️ UNVERIFIED — placeholder is 1155-deployments/1.json FACTORY_PROXY, which
    // is NOT confirmed to be the `createContract` entrypoint (the Base docs
    // factory 0x540C… differs from Base's FACTORY_PROXY). factoryVerified=false
    // keeps the deploy path off mainnet until In Process confirms this address.
    factory: '0x2bf5EBEEb028D5F9E02F0F432Ebb1a192F5528F1',
    factoryVerified: false,
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    seaport: SEAPORT_1_5,
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
