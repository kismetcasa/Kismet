'use client'

/**
 * Gate for the agent UI (Agent Collect): is the connected wallet a smart account
 * that can grant a Base Spend Permission to KISMET's spender? EOAs cannot, so the
 * Agent Collect UI renders only when this returns eligible; everyone else keeps
 * the unchanged per-action flow.
 *
 * Layered, read-only detection (no prompts):
 *   1. EIP-5792 `wallet_getCapabilities` — atomic batch supported on Base?
 *      (Coinbase Smart Wallet / Base Account report this.)
 *   2. Fallback: `eth_getCode(address) !== '0x'` — the account is a deployed
 *      smart contract (also catches ERC-7702-upgraded EOAs, which qualify).
 *
 * SSR-safe: returns { eligible: false, loading: true } until the client effect
 * resolves, so the server render takes the default (non-agent) path.
 */

import { useEffect, useState } from 'react'
import { useAccount, usePublicClient } from 'wagmi'
import { base } from 'wagmi/chains'

interface Eligibility {
  eligible: boolean
  loading: boolean
}

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }

export function useSmartWalletAgentEligibility(): Eligibility {
  const { address, connector, isConnected } = useAccount()
  const publicClient = usePublicClient({ chainId: base.id })
  const [state, setState] = useState<Eligibility>({ eligible: false, loading: true })

  useEffect(() => {
    if (!isConnected || !address || !publicClient) {
      setState({ eligible: false, loading: false })
      return
    }

    let cancelled = false
    setState((s) => ({ ...s, loading: true }))

    void (async () => {
      let eligible = false
      // 1. EIP-5792 capability check via the connected provider.
      try {
        const provider = (await connector?.getProvider?.()) as Eip1193 | undefined
        if (provider?.request) {
          const baseHex = `0x${base.id.toString(16)}`
          const caps = (await provider.request({
            method: 'wallet_getCapabilities',
            params: [address, [baseHex]],
          })) as Record<string, { atomic?: { status?: string }; atomicBatch?: { supported?: boolean } }> | undefined
          const c = caps?.[baseHex] ?? caps?.[String(base.id)]
          if (c?.atomic?.status === 'supported' || c?.atomic?.status === 'ready' || c?.atomicBatch?.supported) {
            eligible = true
          }
        }
      } catch {
        // capability call unsupported — fall through to the code check
      }

      // 2. Fallback: is the connected account a deployed smart contract?
      if (!eligible) {
        try {
          const code = await publicClient.getCode({ address })
          eligible = !!code && code !== '0x'
        } catch {
          eligible = false
        }
      }

      if (!cancelled) setState({ eligible, loading: false })
    })()

    return () => {
      cancelled = true
    }
  }, [address, connector, isConnected, publicClient])

  return state
}
