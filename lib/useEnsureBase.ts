import { useAccount, useSwitchChain } from 'wagmi'
import { BASE_CHAIN_ID, DEFAULT_CHAIN_ID } from '@/lib/chains'

// Returns an async fn that resolves once the wallet is on the requested chain.
// Silent no-op if already there; prompts the wallet to switch otherwise.
// Call before any writeContractAsync so transactions can't land on the wrong chain.
export function useEnsureChain() {
  const { chain } = useAccount()
  const { switchChainAsync } = useSwitchChain()

  return async (chainId: number = DEFAULT_CHAIN_ID) => {
    if (chain?.id === chainId) return
    await switchChainAsync({ chainId })
  }
}

// Back-compat: Base-pinned ensure. Existing callers do
// `const ensureBase = useEnsureBase(); await ensureBase()`. Prefer
// `useEnsureChain()` in new code and pass the moment's target chain.
export function useEnsureBase() {
  const ensureChain = useEnsureChain()
  return async () => ensureChain(BASE_CHAIN_ID)
}
